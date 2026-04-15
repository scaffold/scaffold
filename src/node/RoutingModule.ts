// Protocol spec: docs/protocol/routing.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { GossipModule, SendAction, VerifierKey } from './GossipModule.ts';

// --- Constants ---

/** Sentinel source key for self-originated blocks. */
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
  receivedFirst: Set<HashPrimitive>;
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

  /** All blocks we have locally. */
  private readonly localBlocks = new Set<HashPrimitive>();

  /** Source peer for each block (PeerID or SELF_SOURCE). */
  private readonly blockSources = new Map<HashPrimitive, string>();

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
      receivedFirst: new Set(),
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
   * 1. Updates receivedFirst for fromPeer
   * 2. Calls gossip.addSubscriptionSource for new receivedFirst entries
   * 3. Calls gossip.blockReceived (which emits send actions via callback)
   * 4. handleSendAction maps each to PushAction via trigger->peer routing
   * 5. Adds baseline propagation if no subscription matches
   *
   * Emits PushAction via onPushAction callback.
   */
  blockReceived(hash: Hash, fromPeer: string | null): void {
    const key = hash.toPrimitive();

    // Source integrity: if we already have this block, ignore.
    if (this.localBlocks.has(key)) return;
    this.localBlocks.add(key);

    // Record source
    const sourceKey = fromPeer ?? SELF_SOURCE;
    this.blockSources.set(key, sourceKey);

    // Update sender's state
    if (fromPeer !== null) {
      const senderState = this.peers.get(fromPeer);
      if (senderState) {
        senderState.receivedFirst.add(key);
        senderState.awareness.add(hash);
        // Track utility received (one unit per novel block from this peer)
        senderState.utilityReceived += 1;
      }
    }

    // Begin cycle: collect push actions, dedup by (block, peer)
    this.inCycle = true;
    this.currentCyclePushes.clear();
    // Feed the gossip subscription index from receivedFirst
    if (fromPeer !== null) {
      this.gossip.addSubscriptionSource(hash);
    }

    // Process the block against subscriptions
    this.gossip.blockReceived(hash);

    // End cycle: emit collected push actions
    this.inCycle = false;

    // Emit all collected push actions
    for (const action of this.currentCyclePushes.values()) {
      this.emitPushAction(action);
    }
  }

  // -- Send Action Processing ----------------------------------------

  /**
   * Process a send action from the gossip module.
   * Maps trigger -> peers via receivedFirst, computes priority,
   * deduplicates by (block, peer) keeping highest priority.
   */
  private handleSendAction(action: SendAction): void {
    const blockKey = action.block.toPrimitive();
    const sourceKey = this.blockSources.get(blockKey) ?? SELF_SOURCE;
    const blockSize = this.provider.getBlockSize(action.block);
    if (blockSize <= 0) return;

    for (const [peerId, peerState] of this.peers) {
      // Trigger must be in this peer's receivedFirst
      if (!peerState.receivedFirst.has(action.trigger.toPrimitive())) continue;

      // Skip if peer already has the block
      if (peerState.awareness.has(action.block)) continue;

      // Compute response index (default 1 for first push)
      const responseIdx = (peerState.responseIndex.get(action.verifier) ?? 0) + 1;

      // Compute push priority
      const deliveryRate = this.getFirstDeliveryRate(sourceKey, peerId);
      const priority = (action.amount / responseIdx) * deliveryRate / blockSize;

      if (priority < this.config.minPushPriority) continue;

      const pushAction: PushAction = {
        block: action.block,
        peer: peerId,
        priority,
        immediate: priority > this.config.immediateThreshold,
        verifier: action.verifier,
      };

      // Dedup by (block, peer): keep highest priority
      if (this.inCycle) {
        const dedupKey = `${blockKey}:${peerId}`;
        const existing = this.currentCyclePushes.get(dedupKey);
        if (!existing || pushAction.priority > existing.priority) {
          this.currentCyclePushes.set(dedupKey, pushAction);
        }
      } else {
        // Outside a cycle (e.g., deferred resolution), emit directly
        this.emitPushAction(pushAction);
      }
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
    const key = block.toPrimitive();
    const sourceKey = this.blockSources.get(key) ?? SELF_SOURCE;
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
    const novelty = state.receivedFirst.size;
    const reciprocity = this.getReciprocity(peer);
    return novelty * Math.min(reciprocity, 2);
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
    let bestSize = 0;
    for (const [peerId, state] of this.peers) {
      if (state.receivedFirst.size > bestSize) {
        bestSize = state.receivedFirst.size;
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
