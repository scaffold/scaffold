import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { BlockAwareness } from '../src/core/GossipModule.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { BlockCreationService } from '../src/core/BlockCreationService.ts';
import { GossipService } from '../src/core/GossipService.ts';
import { Coordinator } from '../src/core/Coordinator.ts';
import { composeGenesisPacket } from '../src/core/Packet.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { BlockInfo, InFlightMessage } from './types.ts';
import { NODE_NAMES } from './colors.ts';

// -- Helpers --

class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();
  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }
  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

function nonceOutput(nodeIdx: number, seqNum: number): Output {
  const detail = new Uint8Array(8);
  const view = new DataView(detail.buffer);
  view.setUint32(0, nodeIdx);
  view.setUint32(4, seqNum);
  return {
    verifier: { contract: Hash.digest('viz-nonce'), params: new Uint8Array(0) },
    value: 0,
    detail,
  };
}

// -- SimNode --

class SimNode {
  readonly scaffold: Scaffold;

  constructor(_id: string) {
    const { block: vizGenesis } = composeGenesisPacket([nonceOutput(999, 0)]);
    this.scaffold = new Scaffold({ genesis: vizGenesis });
  }

  get store(): BlockStore {
    return this.scaffold.context.store;
  }

  get coordinator(): Coordinator {
    return this.scaffold.context.coordinator;
  }

  get consensus(): ConsensusService {
    return this.scaffold.context.consensus;
  }

  get gossip(): GossipService {
    return this.scaffold.context.gossip;
  }

  get blockCreation(): BlockCreationService {
    return this.scaffold.context.blockCreation;
  }
}

// -- SimEngine --

export interface SimConfig {
  nodeCount: number;
  publishInterval: number;
  aggregateInterval: number;
  deliveryDelay: number;
  /** Weight threshold for forwarding probability. P(fwd) = min(1, weightSum / threshold). */
  forwardThreshold: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  nodeCount: 5,
  publishInterval: 10,
  aggregateInterval: 20,
  deliveryDelay: 3,
  forwardThreshold: 5,
};

/** Simple seeded PRNG for deterministic gossip filtering. */
class SeededRandom {
  private state: number;
  constructor(seed: number) {
    this.state = seed;
  }
  next(): number {
    // xorshift32
    this.state ^= this.state << 13;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) / 0xFFFFFFFF;
  }
}

export class SimEngine {
  readonly nodes: SimNode[] = [];
  readonly nodeNames: string[] = [];

  /** All blocks known to any node, with metadata. */
  readonly blockInfos = new Map<HashPrimitive, BlockInfo>();

  /** In-flight messages. */
  readonly inFlight: InFlightMessage[] = [];

  /** Connection graph: edges stored as "a|b" where a < b. */
  readonly connections = new Set<string>();

  /** Per-node publication counters. */
  private readonly seqNums: number[] = [];

  /** Per-node tick counters for publication/aggregation. */
  private readonly pubTimers: number[] = [];
  private readonly aggTimers: number[] = [];

  /** Per-node publication intervals (0 = paused). */
  readonly pubIntervals: number[];

  /** Per-node aggregation intervals. */
  readonly aggIntervals: number[];

  readonly deliveryDelay: number;
  private readonly forwardThreshold: number;
  private readonly rng = new SeededRandom(42);
  tick = 0;
  genesis!: Block;

  constructor(config: Partial<SimConfig> = {}) {
    const c = { ...DEFAULT_CONFIG, ...config };
    this.deliveryDelay = c.deliveryDelay;
    this.forwardThreshold = c.forwardThreshold;

    const nodeCount = Math.min(c.nodeCount, NODE_NAMES.length);
    this.pubIntervals = new Array(nodeCount).fill(c.publishInterval);
    this.aggIntervals = new Array(nodeCount).fill(c.aggregateInterval);

    // Create nodes
    for (let i = 0; i < nodeCount; i++) {
      const name = NODE_NAMES[i];
      const node = new SimNode(name);
      this.nodes.push(node);
      this.nodeNames.push(name);
      this.seqNums.push(0);
      this.pubTimers.push(0);
      this.aggTimers.push(0);
    }

    // Default: ring topology
    for (let i = 0; i < nodeCount; i++) {
      const j = (i + 1) % nodeCount;
      this.connect(i, j);
    }

    // Get genesis from the first node's store (all nodes share the same genesis)
    const ctx = this.nodes[0].scaffold.context;
    this.genesis = ctx.store.get(ctx.genesisHash)!;
    this.blockInfos.set(this.genesis.hash.toPrimitive(), {
      block: this.genesis,
      creator: -1,
      depth: 0,
      seqNum: 0,
    });
  }

  /** Canonical edge key. */
  private edgeKey(a: number, b: number): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /** Connect two nodes. */
  connect(a: number, b: number): void {
    if (a === b) return;
    const key = this.edgeKey(a, b);
    if (this.connections.has(key)) return;
    this.connections.add(key);

    const nameA = this.nodeNames[a];
    const nameB = this.nodeNames[b];
    this.nodes[a].gossip.addPeer(nameB, nameB, new SetAwareness());
    this.nodes[b].gossip.addPeer(nameA, nameA, new SetAwareness());
  }

  /** Disconnect two nodes. */
  disconnect(a: number, b: number): void {
    if (a === b) return;
    const key = this.edgeKey(a, b);
    if (!this.connections.has(key)) return;
    this.connections.delete(key);

    const nameA = this.nodeNames[a];
    const nameB = this.nodeNames[b];
    this.nodes[a].gossip.removePeer(nameB);
    this.nodes[b].gossip.removePeer(nameA);
  }

  /** Toggle connection between two nodes. */
  toggleConnection(a: number, b: number): void {
    const key = this.edgeKey(a, b);
    if (this.connections.has(key)) {
      this.disconnect(a, b);
    } else {
      this.connect(a, b);
    }
  }

  /** Check if two nodes are connected. */
  isConnected(a: number, b: number): boolean {
    return this.connections.has(this.edgeKey(a, b));
  }

  /** Get the tip (deepest canonical block) for a node. */
  getTip(nodeIdx: number): Hash {
    const node = this.nodes[nodeIdx];
    const canonical = node.consensus.getCanonicalView();
    let bestHash = this.genesis.hash;
    let bestDepth = 0;

    for (const key of canonical) {
      const info = this.blockInfos.get(key);
      if (info && info.depth > bestDepth) {
        bestDepth = info.depth;
        bestHash = info.block.hash;
      }
    }
    return bestHash;
  }

  /** Advance the simulation by one tick. */
  doTick(): void {
    this.tick++;

    // 1. Deliver arrived messages
    const arrived: InFlightMessage[] = [];
    const stillFlying: InFlightMessage[] = [];
    for (const msg of this.inFlight) {
      if (this.tick >= msg.arriveTick) {
        arrived.push(msg);
      } else {
        stillFlying.push(msg);
      }
    }
    this.inFlight.length = 0;
    this.inFlight.push(...stillFlying);

    for (const msg of arrived) {
      this.deliverMessage(msg);
    }

    // 2. Publish leaf blocks
    for (let i = 0; i < this.nodes.length; i++) {
      const interval = this.pubIntervals[i];
      if (interval <= 0) continue;
      this.pubTimers[i]++;
      if (this.pubTimers[i] >= interval) {
        this.pubTimers[i] = 0;
        this.publishLeaf(i);
      }
    }

    // 3. Attempt aggregation
    for (let i = 0; i < this.nodes.length; i++) {
      const interval = this.aggIntervals[i];
      if (interval <= 0) continue;
      this.aggTimers[i]++;
      if (this.aggTimers[i] >= interval) {
        this.aggTimers[i] = 0;
        this.attemptAggregation(i);
      }
    }
  }

  /** Publish a leaf block from a node. */
  private publishLeaf(nodeIdx: number): void {
    const node = this.nodes[nodeIdx];
    const tip = this.getTip(nodeIdx);
    const seq = this.seqNums[nodeIdx]++;

    const result = node.scaffold.put({
      anchor: tip,
      outputs: [nonceOutput(nodeIdx, seq)],
    });

    // Determine depth
    const anchorInfo = this.blockInfos.get(tip.toPrimitive());
    const depth = (anchorInfo?.depth ?? 0) + 1;

    // Register block
    this.blockInfos.set(result.hash.toPrimitive(), {
      block: result.block,
      creator: nodeIdx,
      depth,
      seqNum: seq,
    });

    // Own blocks: always deliver to all connected peers (initial publication)
    this.enqueueToConnected(result.block, nodeIdx);
  }

  /** Aggregation is now handled by the contract pipeline (DraftStrategy + AggregationContract). */
  private attemptAggregation(_nodeIdx: number): void {
    // No-op: aggregation blocks are created automatically by the
    // aggregation contract when enough marker outputs accumulate.
  }

  /** Enqueue a block to all connected peers (used for own blocks - always delivered). */
  private enqueueToConnected(block: Block, fromIdx: number): void {
    for (let i = 0; i < this.nodes.length; i++) {
      if (i === fromIdx) continue;
      if (!this.isConnected(fromIdx, i)) continue;

      this.inFlight.push({
        block,
        from: fromIdx,
        to: i,
        departTick: this.tick,
        arriveTick: this.tick + this.deliveryDelay,
      });
    }
  }

  /**
   * Deliver a message to its target node.
   * Forwarding to further peers uses weight-gated probability:
   * P(forward) = min(1, weightSum / forwardThreshold).
   * Leaf blocks (weight=1) rarely propagate beyond direct peers.
   * Large aggregations (high weight) always propagate.
   */
  private deliverMessage(msg: InFlightMessage): void {
    const node = this.nodes[msg.to];

    if (node.store.has(msg.block.hash)) return;
    if (!this.blockInfos.has(msg.block.hash.toPrimitive())) return;

    node.scaffold.context.processBlock(msg.block, this.nodeNames[msg.from]);

    // Weight-gated forwarding to further connected peers
    const weightSum = getBlockWeightVector(msg.block).reduce((a, b) => a + b, 0);
    const forwardProb = Math.min(1, weightSum / this.forwardThreshold);

    for (let i = 0; i < this.nodes.length; i++) {
      if (i === msg.to || i === msg.from) continue;
      if (!this.isConnected(msg.to, i)) continue;
      if (this.nodes[i].store.has(msg.block.hash)) continue;

      // Probabilistic forwarding based on block weight
      if (this.rng.next() < forwardProb) {
        this.inFlight.push({
          block: msg.block,
          from: msg.to,
          to: i,
          departTick: this.tick,
          arriveTick: this.tick + this.deliveryDelay,
        });
      }
    }
  }
}
