// Protocol spec: docs/protocol/routing.md

import { Hash } from '../util/Hash.ts';
import { GossipModule, SendAction, VerifierKey } from './GossipModule.ts';

// --- Constants ---

/** Sentinel source key for self-originated blocks (no inbound peer). */
const SELF_SOURCE = '__self__';

// --- Configuration ---

/** Tunable parameters for the routing module. */
export interface RoutingConfig {
  /** Push priority above this threshold triggers immediate push. */
  immediateThreshold: number;
  /** Minimum push priority to consider pushing at all. */
  minPushPriority: number;

  /** Guaranteed minimum bandwidth per peer (bytes/sec). */
  baseRate: number;
  /** Additional bandwidth for reciprocal peers (bytes/sec). */
  bonusRate: number;

  /** Decay factor (0-1) for delivery matrix entries. */
  matrixDecayFactor: number;
  /** Decay factor (0-1) for reciprocity accumulators. */
  reciprocityDecayFactor: number;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  immediateThreshold: 50,
  minPushPriority: 0.01,

  baseRate: 1024,
  bonusRate: 10240,

  matrixDecayFactor: 0.95,
  reciprocityDecayFactor: 0.95,
};

// --- Provider ---

/**
 * Provider interface for the routing module to access block metadata.
 */
export interface RoutingProvider {
  /** Serialized size of the block in bytes. */
  getBlockSize(hash: Hash): number;
  /** Whether the block is in the local store. */
  hasBlock(hash: Hash): boolean;
  /**
   * Source peer (first sender) for the block, or undefined for
   * self-originated atoms. Reads `block.fromConnections[0]`.
   */
  getBlockSource(hash: Hash): string | undefined;
  /**
   * Record that `peerId` sent us this block. Idempotent; pushes onto
   * the stored atom's `fromConnections` only if not already present.
   * Called by `routing.blockReceived` so the source is canonical even
   * when the input atom was constructed without per-peer attribution
   * (e.g. in-process simulation tests).
   */
  recordSource(hash: Hash, peerId: string): void;
}

// --- Types ---

/**
 * Abstraction for tracking which blocks a peer is known to have.
 * Implementations may use a simple Set, bloom filter, or set sketch.
 */
export interface BlockAwareness {
  /** Whether the peer is known to have this block. */
  has(hash: Hash): boolean;
  /** Record that the peer has this block. */
  add(hash: Hash): void;
}

/** A decision to push a block to a peer. */
export interface PushAction {
  /** The block to push. */
  readonly block: Hash;
  /** The target peer. */
  readonly peer: string;
  /** Priority score. Higher = more important. */
  readonly priority: number;
  /** Whether this should be pushed immediately (vs. queued for deferred sending). */
  readonly immediate: boolean;
  /** The verifier key that triggered this push (for response index tracking). */
  readonly verifier?: VerifierKey;
}

// --- Internal State ---

interface BetaState {
  alpha: number;
  beta: number;
}

interface RoutingPeerState {
  pubkey: string;
  /**
   * Count of distinct blocks for which this peer was the first sender
   * (i.e. their peerId is `block.fromConnections[0]`). Replaces the
   * legacy `receivedFirst: Set<HashPrimitive>` whose only consumers
   * needed the cardinality.
   */
  noveltyCount: number;
  deliveryMatrix: Map<string, BetaState>;
  awareness: BlockAwareness;
  utilitySent: number;
  utilityReceived: number;
  responseIndex: Map<VerifierKey, number>;
}

// --- Module ---

/**
 * The routing module delivers blocks to the peers who need them.
 * It takes send actions from the gossip module and maps them to
 * specific peers, managing bandwidth, topology learning, and
 * delivery efficiency.
 *
 * This module is the "how to send" layer. The gossip module
 * determines which blocks match which subscriptions; this module
 * determines which peer receives each block, when, and at what priority.
 */
export class RoutingModule {
  private readonly provider: RoutingProvider;
  private readonly gossip: GossipModule;
  private readonly config: RoutingConfig;

  /** Per-peer state. */
  private readonly peers = new Map<string, RoutingPeerState>();

  /** Push action listeners. */
  private readonly pushActionListeners: ((action: PushAction) => void)[] = [];

  /**
   * Dedup for (block, peer) push actions within a single blockReceived cycle.
   * Maps "blockHash:peerId" -> priority. Keeps highest priority.
   */
  private currentCyclePushes = new Map<string, PushAction>();

  /** Whether we're inside a blockReceived cycle (for batching). */
  private inCycle = false;

  constructor(
    provider: RoutingProvider,
    gossip: GossipModule,
    config?: Partial<RoutingConfig>,
  ) {
    this.provider = provider;
    this.gossip = gossip;
    this.config = { ...DEFAULT_ROUTING_CONFIG, ...config };

    // Register for send actions from gossip module
    gossip.onSendAction((action) => this.handleSendAction(action));
  }

  // -- Listener Registration ----------------------------------------

  /** Register a callback for push actions (consumed by NetworkBridge). */
  onPushAction(cb: (action: PushAction) => void): void {
    this.pushActionListeners.push(cb);
  }

  // -- Peer Lifecycle -----------------------------------------------

  /** Register a new peer. */
  addPeer(peer: string, pubkey: string, awareness: BlockAwareness): void {
    if (this.peers.has(peer)) return;
    this.peers.set(peer, {
      pubkey,
      noveltyCount: 0,
      deliveryMatrix: new Map(),
      awareness,
      utilitySent: 0,
      utilityReceived: 0,
      responseIndex: new Map(),
    });
  }

  /** Remove a peer. */
  removePeer(peer: string): void {
    this.peers.delete(peer);
  }

  /** Get IDs of all connected peers. */
  getPeerIds(): string[] {
    return [...this.peers.keys()];
  }

  // -- Block Events -------------------------------------------------

  /**
   * Record a new block and compute push targets.
   *
   * `fromPeer` is informational here -- the canonical source is the
   * atom's `fromConnections[0]`, which `BlockStore.put` populated
   * before this call. We use `fromPeer` only to update per-peer
   * novelty/awareness counters.
   *
   * Emits PushAction via onPushAction callback.
   */
  blockReceived(hash: Hash, fromPeer: string | null): void {
    if (fromPeer !== null) {
      // Ensure the stored atom records this sender. In production
      // PeerConnection populated fromConnections at deserialize time;
      // this call is idempotent then. In sim tests the atom may have
      // been constructed without attribution, and this is the only
      // source-recording path.
      this.provider.recordSource(hash, fromPeer);

      const senderState = this.peers.get(fromPeer);
      if (senderState) {
        if (this.provider.getBlockSource(hash) === fromPeer) {
          senderState.noveltyCount += 1;
        }
        senderState.awareness.add(hash);
        senderState.utilityReceived += 1;
      }
    }

    // Begin cycle: collect push actions, dedup by (block, peer)
    this.inCycle = true;
    this.currentCyclePushes.clear();

    // Process the block against claim history
    this.gossip.blockReceived(hash);

    // End cycle: emit collected push actions
    this.inCycle = false;

    for (const action of this.currentCyclePushes.values()) {
      this.emitPushAction(action);
    }
  }

  // -- Send Action Processing ----------------------------------------

  /**
   * Process a send action from the gossip module.
   * Targets the trigger atom's first sender (`fromConnections[0]`),
   * which is the reverse-path peer that originally sent us the
   * triggering block.
   */
  private handleSendAction(action: SendAction): void {
    const blockKey = action.block.toPrimitive();
    const blockSize = this.provider.getBlockSize(action.block);
    if (blockSize <= 0) return;

    // Reverse-path target: the first sender of the trigger atom.
    const triggerSource = this.provider.getBlockSource(action.trigger);
    if (triggerSource === undefined) return; // self-originated trigger -- nothing to forward to
    const peerState = this.peers.get(triggerSource);
    if (!peerState) return; // peer disconnected

    // Skip if peer already has the block.
    if (peerState.awareness.has(action.block)) return;

    const blockSourceRaw = this.provider.getBlockSource(action.block);
    const blockSource = blockSourceRaw ?? null;

    const responseIdx = (peerState.responseIndex.get(action.verifier) ?? 0) + 1;
    const deliveryRate = this.getFirstDeliveryRate(blockSource, triggerSource);
    const priority = (action.amount / responseIdx) * deliveryRate / blockSize;

    if (priority < this.config.minPushPriority) return;

    const pushAction: PushAction = {
      block: action.block,
      peer: triggerSource,
      priority,
      immediate: priority > this.config.immediateThreshold,
      verifier: action.verifier,
    };

    if (this.inCycle) {
      const dedupKey = `${blockKey}:${triggerSource}`;
      const existing = this.currentCyclePushes.get(dedupKey);
      if (!existing || pushAction.priority > existing.priority) {
        this.currentCyclePushes.set(dedupKey, pushAction);
      }
    } else {
      this.emitPushAction(pushAction);
    }
  }

  // -- Feedback -----------------------------------------------------

  /**
   * Record that we pushed a block to a peer.
   * Updates response index and utility tracking.
   */
  reportPush(block: Hash, peer: string, verifier?: VerifierKey): void {
    const state = this.peers.get(peer);
    if (!state) return;

    // Increment response index for this (peer, verifier) pair
    if (verifier) {
      const current = state.responseIndex.get(verifier) ?? 0;
      state.responseIndex.set(verifier, current + 1);
    }

    // Track utility sent (use a simple heuristic: 1 per push)
    state.utilitySent += 1;
  }

  /**
   * Report whether a pushed block was novel to the peer.
   * Updates the delivery matrix entry for (block.source, peer).
   */
  reportDelivery(block: Hash, peer: string, wasNovel: boolean): void {
    const sourceKey = this.provider.getBlockSource(block) ?? SELF_SOURCE;
    const state = this.peers.get(peer);
    if (!state) return;

    let entry = state.deliveryMatrix.get(sourceKey);
    if (!entry) {
      entry = { alpha: 1, beta: 1 }; // Beta(1,1) prior
      state.deliveryMatrix.set(sourceKey, entry);
    }

    if (wasNovel) {
      entry.alpha += 1;
    } else {
      entry.beta += 1;
    }
  }

  // -- Delivery Matrix -----------------------------------------------

  /**
   * Expected first-delivery rate from the delivery matrix.
   * @param source PeerID of block source, or null for self-originated.
   * @param dest PeerID of the target peer.
   */
  getFirstDeliveryRate(source: string | null, dest: string): number {
    const state = this.peers.get(dest);
    if (!state) return 0;
    const sourceKey = source ?? SELF_SOURCE;
    const entry = state.deliveryMatrix.get(sourceKey);
    if (!entry) return 0.5; // Beta(1,1) prior -> E = 0.5
    return entry.alpha / (entry.alpha + entry.beta);
  }

  // -- Bandwidth & Reciprocity --------------------------------------

  /** Bandwidth budget for a peer (bytes/sec). */
  getBandwidthBudget(peer: string): number {
    const r = this.getReciprocity(peer);
    const { baseRate, bonusRate } = this.config;
    return baseRate + bonusRate * sigmoid(r - 1);
  }

  /** Reciprocity score: utility received / utility sent. Neutral = 1. */
  getReciprocity(peer: string): number {
    const state = this.peers.get(peer);
    if (!state) return 0;
    if (state.utilitySent === 0 && state.utilityReceived === 0) return 1;
    if (state.utilitySent === 0) return 2;
    return state.utilityReceived / state.utilitySent;
  }

  /**
   * Gossip quality score for a peer. Higher = more valuable connection.
   */
  getGossipQuality(peer: string): number {
    const state = this.peers.get(peer);
    if (!state) return 0;
    const reciprocity = this.getReciprocity(peer);
    return state.noveltyCount * Math.min(reciprocity, 2);
  }

  // -- Fetch Interface -----------------------------------------------

  /**
   * Find the best peer to fetch a block from.
   * Prefers peers whose awareness includes the block.
   * Falls back to the most well-connected peer.
   */
  bestPeerForFetch(hash: Hash): string | undefined {
    for (const [peerId, state] of this.peers) {
      if (state.awareness.has(hash)) return peerId;
    }

    let best: string | undefined;
    let bestCount = 0;
    for (const [peerId, state] of this.peers) {
      if (state.noveltyCount > bestCount) {
        bestCount = state.noveltyCount;
        best = peerId;
      }
    }
    return best;
  }

  // -- Maintenance --------------------------------------------------

  /**
   * Decay all delivery matrix entries and reciprocity accumulators.
   * Should be called periodically to adapt to topology changes.
   */
  decayMatrices(): void {
    const { matrixDecayFactor, reciprocityDecayFactor } = this.config;
    for (const [, state] of this.peers) {
      for (const [, entry] of state.deliveryMatrix) {
        entry.alpha *= matrixDecayFactor;
        entry.beta *= matrixDecayFactor;
      }
      state.utilitySent *= reciprocityDecayFactor;
      state.utilityReceived *= reciprocityDecayFactor;
    }
  }

  // -- Internals ----------------------------------------------------

  private emitPushAction(action: PushAction): void {
    for (const cb of this.pushActionListeners) {
      cb(action);
    }
  }
}

// --- Utilities ---

/** Standard sigmoid function. Maps (-inf, inf) to (0, 1). */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
