import { Hash } from '../src/util/Hash.ts';
import { Block, BlockStore } from '../src/core/Block.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { ProbeService } from '../src/core/ProbeService.ts';
import { TrustService } from '../src/core/TrustService.ts';
import { GossipService } from '../src/core/GossipService.ts';
import { BlockCreationService } from '../src/core/BlockCreationService.ts';
import { ExecutionService } from '../src/core/ExecutionService.ts';
import { VerificationService } from '../src/core/VerificationService.ts';
import { BlockReceivedResult, Coordinator } from '../src/core/Coordinator.ts';
import { BlockAwareness, PushAction } from '../src/core/GossipModule.ts';

/** Simple set-based block awareness tracker. */
class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();

  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }

  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

/** A simulated node running the full protocol stack. */
export class SimNode {
  readonly id: string;
  readonly ctx: ProtocolContext;
  readonly store: BlockStore;
  readonly coordinator: Coordinator;
  readonly consensus: ConsensusService;
  readonly probe: ProbeService;
  readonly trust: TrustService;
  readonly gossip: GossipService;
  readonly blockCreation: BlockCreationService;
  readonly execution: ExecutionService;
  readonly verification: VerificationService;

  constructor(id: string) {
    this.id = id;
    this.ctx = new ProtocolContext();

    // Eagerly initialize all services so they're wired up
    this.store = this.ctx.get(BlockStore);
    this.consensus = this.ctx.get(ConsensusService);
    this.probe = this.ctx.get(ProbeService);
    this.trust = this.ctx.get(TrustService);
    this.gossip = this.ctx.get(GossipService);
    this.blockCreation = this.ctx.get(BlockCreationService);
    this.execution = this.ctx.get(ExecutionService);
    this.verification = this.ctx.get(VerificationService);
    this.coordinator = this.ctx.get(Coordinator);
  }

  /** Process a received block. */
  receiveBlock(block: Block, fromPeer: string | null): BlockReceivedResult {
    return this.coordinator.blockReceived(block, fromPeer);
  }
}

/** In-memory multi-node simulation network. */
export class SimNetwork {
  private readonly nodes = new Map<string, SimNode>();

  /** Create and register a new node. */
  addNode(id: string): SimNode {
    const node = new SimNode(id);
    this.nodes.set(id, node);

    // Connect all nodes to each other via gossip
    for (const [otherId, otherNode] of this.nodes) {
      if (otherId === id) continue;
      node.gossip.addPeer(otherId, otherId, new SetAwareness());
      otherNode.gossip.addPeer(id, id, new SetAwareness());
    }

    return node;
  }

  /** Get a node by id. */
  getNode(id: string): SimNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Broadcast a block to all nodes.
   * The source node receives it as self-originated (fromPeer=null).
   * All other nodes receive it from the source node.
   */
  deliverToAll(block: Block, sourceNodeId: string): Map<string, BlockReceivedResult> {
    const results = new Map<string, BlockReceivedResult>();

    for (const [nodeId, node] of this.nodes) {
      const fromPeer = nodeId === sourceNodeId ? null : sourceNodeId;
      const result = node.receiveBlock(block, fromPeer);
      results.set(nodeId, result);
    }

    return results;
  }

  /**
   * Process push actions from a block received result.
   * Delivers the block to each target peer.
   */
  processPushActions(
    sourceNodeId: string,
    block: Block,
    pushActions: PushAction[],
  ): Map<string, BlockReceivedResult> {
    const results = new Map<string, BlockReceivedResult>();

    for (const action of pushActions) {
      const targetNode = this.nodes.get(action.peer);
      if (!targetNode) continue;
      if (targetNode.store.has(block.hash)) continue;

      const result = targetNode.receiveBlock(block, sourceNodeId);
      results.set(action.peer, result);
    }

    return results;
  }
}
