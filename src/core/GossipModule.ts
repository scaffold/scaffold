import { Hash, HashPrimitive } from '../util/Hash.ts';

// --- Constants ---

/** Sentinel source key for self-originated blocks. */
const SELF_SOURCE = '__self__';

// --- Configuration ---

/** Tunable parameters for the gossip module. */
export interface GossipConfig {
  /** Relevance weight: block claims an output of a block in peer's receivedFirst. */
  rClaim: number;
  /** Relevance weight: block is collateral for/against a block in peer's receivedFirst. */
  rCollateral: number;
  /** Relevance weight: block aggregates a block in peer's receivedFirst. */
  rAggregate: number;
  /** Relevance weight: block contains a payment restricted to peer's pubkey. */
  rPayment: number;
  /** Relevance weight: no specific relationship (baseline). */
  rDefault: number;

  /** Utility above this threshold triggers immediate push (no deferred queuing). */
  immediateThreshold: number;
  /** Minimum push priority to consider pushing at all. */
  minPushPriority: number;
  /** Minimum total collateral stake for contestedness bonus to apply. */
  minContestednessStake: number;

  /** Guaranteed minimum bandwidth per peer (bytes/sec). */
  baseRate: number;
  /** Additional bandwidth for reciprocal peers (bytes/sec). */
  bonusRate: number;

  /** Decay factor (0–1) for delivery matrix entries. Applied by decayMatrices(). */
  matrixDecayFactor: number;
  /** Decay factor (0–1) for reciprocity accumulators. Applied by decayMatrices(). */
  reciprocityDecayFactor: number;
}

export const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  rClaim: 5,
  rCollateral: 4,
  rAggregate: 3,
  rPayment: 10,
  rDefault: 1,

  immediateThreshold: 50,
  minPushPriority: 0.01,
  minContestednessStake: 100,

  baseRate: 1024,
  bonusRate: 10240,

  matrixDecayFactor: 0.95,
  reciprocityDecayFactor: 0.95,
};

// --- Provider Interfaces ---

/**
 * Provider interface for the gossip module to access block metadata.
 *
 * All block-specific knowledge flows through this interface.
 * The gossip module never inspects block internals directly.
 */
export interface GossipProvider {
  /** Serialized size of the block in bytes. */
  getBlockSize(hash: Hash): number;

  /** Sum of the block's declared weight vector. */
  getBlockWeightSum(hash: Hash): number;

  /**
   * Blocks whose outputs this block claims (spends).
   * Typically includes the anchor block if the block has any claims.
   */
  getClaimedOrigins(block: Hash): Hash[];

  /**
   * If this block is a collateral posting (FOR or AGAINST),
   * returns the target block hash. Otherwise undefined.
   */
  getCollateralTarget(block: Hash): Hash | undefined;

  /** Blocks this block aggregates (replaces). */
  getAggregatedBlocks(block: Hash): Hash[];

  /**
   * If this block contains a payment output restricted to a specific pubkey,
   * returns that pubkey. Otherwise undefined.
   */
  getPaymentTarget(block: Hash): string | undefined;

  /** Total FOR collateral stake on a target block. */
  getForStake(target: Hash): number;

  /** Total AGAINST collateral stake on a target block. */
  getAgainstStake(target: Hash): number;
}

/**
 * Abstraction for tracking which blocks a peer is known to have.
 *
 * Implementations may use a simple Set, bloom filter, or set sketch.
 * The gossip module is parameterized on this — it does not assume
 * which mechanism is used.
 */
export interface BlockAwareness {
  /** Whether the peer is known to have this block. Conservative: false if unknown. */
  has(hash: Hash): boolean;
  /** Record that the peer has this block. */
  add(hash: Hash): void;
}

// --- Output Types ---

/** A decision to push a block to a peer. Returned by blockReceived(). */
export interface PushAction {
  /** The block to push. */
  block: Hash;
  /** The target peer. */
  peer: string;
  /** Priority score (utility × novelty / size). Higher = more important. */
  priority: number;
  /** Whether this should be pushed immediately (vs. queued for deferred sending). */
  immediate: boolean;
}

// --- Internal State Types ---

interface BetaState {
  alpha: number;
  beta: number;
}

interface PeerState {
  pubkey: string;
  receivedFirst: Set<HashPrimitive>;
  deliveryMatrix: Map<string, BetaState>;
  awareness: BlockAwareness;
  utilitySent: number;
  utilityReceived: number;
}

// --- Module ---

/**
 * The gossip module distributes blocks to peers via push-based gossip.
 *
 * It decides which blocks to push to which peers, learns network topology
 * through delivery feedback, and manages per-peer bandwidth budgets based
 * on reciprocity.
 *
 * Fully self-contained — depends only on GossipProvider and Hash.
 */
export class GossipModule {
  private readonly provider: GossipProvider;
  private readonly config: GossipConfig;

  /** All blocks we have locally, keyed by hash primitive. */
  private readonly localBlocks = new Set<HashPrimitive>();

  /** Source peer for each block (PeerID or SELF_SOURCE). */
  private readonly blockSources = new Map<HashPrimitive, string>();

  /** Per-peer state. */
  private readonly peers = new Map<string, PeerState>();

  constructor(provider: GossipProvider, config?: Partial<GossipConfig>) {
    this.provider = provider;
    this.config = { ...DEFAULT_GOSSIP_CONFIG, ...config };
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
    });
  }

  /** Remove a peer. */
  removePeer(peer: string): void {
    this.peers.delete(peer);
  }

  // -- Block Events -------------------------------------------------

  /**
   * Record a new block and compute push targets.
   *
   * If fromPeer is non-null, the block is added to that peer's receivedFirst
   * set (source integrity: only if we didn't already have the block).
   *
   * Returns push actions sorted by priority (descending).
   * The caller is responsible for actually sending the blocks.
   */
  blockReceived(hash: Hash, fromPeer: string | null): PushAction[] {
    const key = hash.toPrimitive();

    // Source integrity: if we already have this block, ignore.
    // This prevents echo inflation — if we push X to P and P echoes it back,
    // the second call is a no-op and X is NOT added to P's receivedFirst.
    if (this.localBlocks.has(key)) return [];
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
        // Track utility received (base utility of the block)
        senderState.utilityReceived += this.computeBaseUtility(hash);
      }
    }

    // Compute push targets
    const actions: PushAction[] = [];
    for (const [peerId, peerState] of this.peers) {
      if (peerId === fromPeer) continue; // don't echo back to sender
      if (peerState.awareness.has(hash)) continue; // peer already has it

      const utility = this.computeUtility(hash, peerId);
      const novelty = this.computeNovelty(hash, peerId);
      const size = this.provider.getBlockSize(hash);
      const priority = size > 0 ? (utility * novelty) / size : 0;

      if (priority >= this.config.minPushPriority) {
        actions.push({
          block: hash,
          peer: peerId,
          priority,
          immediate: utility > this.config.immediateThreshold,
        });
      }
    }

    // Sort by priority descending
    actions.sort((a, b) => b.priority - a.priority);
    return actions;
  }

  // -- Feedback -----------------------------------------------------

  /**
   * Record that we pushed a block to a peer.
   * Updates the peer's utilitySent for reciprocity tracking.
   */
  reportPush(block: Hash, peer: string): void {
    const state = this.peers.get(peer);
    if (!state) return;
    state.utilitySent += this.computeUtility(block, peer);
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

  // -- Utility Queries ----------------------------------------------

  /** Full utility score for a (block, peer) pair. */
  computeUtility(block: Hash, peer: string): number {
    return this.computeBaseUtility(block) * this.computeRelevance(block, peer);
  }

  /** Base utility: importance of the block to the network. */
  computeBaseUtility(block: Hash): number {
    const weight = this.provider.getBlockWeightSum(block);
    const forStake = this.provider.getForStake(block);
    const againstStake = this.provider.getAgainstStake(block);
    const totalStake = forStake + againstStake;

    let contestednessBonus = 0;
    if (totalStake >= this.config.minContestednessStake) {
      const maxStake = Math.max(forStake, againstStake);
      const minStake = Math.min(forStake, againstStake);
      const contestedness = maxStake > 0 ? minStake / maxStake : 0;
      contestednessBonus = contestedness * totalStake;
    }

    return weight + contestednessBonus;
  }

  /**
   * Relevance: how likely is the peer to care about this block?
   * Based on receivedFirst set and payment target.
   */
  computeRelevance(block: Hash, peer: string): number {
    const state = this.peers.get(peer);
    if (!state) return this.config.rDefault;

    const { rClaim, rCollateral, rAggregate, rPayment, rDefault } = this.config;
    let best = rDefault;

    // Check payment (uses pubkey, not receivedFirst)
    const paymentTarget = this.provider.getPaymentTarget(block);
    if (paymentTarget !== undefined && paymentTarget === state.pubkey) {
      best = Math.max(best, rPayment);
    }

    // Check claimed origins
    const claimedOrigins = this.provider.getClaimedOrigins(block);
    for (const origin of claimedOrigins) {
      if (state.receivedFirst.has(origin.toPrimitive())) {
        best = Math.max(best, rClaim);
        break;
      }
    }

    // Check collateral target
    const collateralTarget = this.provider.getCollateralTarget(block);
    if (collateralTarget !== undefined) {
      if (state.receivedFirst.has(collateralTarget.toPrimitive())) {
        best = Math.max(best, rCollateral);
      }
    }

    // Check aggregated blocks
    const aggregated = this.provider.getAggregatedBlocks(block);
    for (const agg of aggregated) {
      if (state.receivedFirst.has(agg.toPrimitive())) {
        best = Math.max(best, rAggregate);
        break;
      }
    }

    return best;
  }

  /**
   * Novelty: probability we'll be the first to deliver this block to the peer.
   * Derived from the delivery matrix entry for (block.source, peer).
   */
  computeNovelty(block: Hash, peer: string): number {
    const key = block.toPrimitive();
    const sourceKey = this.blockSources.get(key) ?? SELF_SOURCE;
    return this.getFirstDeliveryRate(sourceKey, peer);
  }

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
    if (!entry) return 0.5; // Beta(1,1) prior → E = 0.5
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
    // Avoid division by zero; new peers start neutral
    if (state.utilitySent === 0 && state.utilityReceived === 0) return 1;
    if (state.utilitySent === 0) return 2; // received without sending → generous
    return state.utilityReceived / state.utilitySent;
  }

  /**
   * Gossip quality score for a peer. Higher = more valuable connection.
   * Used by PeerModule for connection decisions.
   */
  getGossipQuality(peer: string): number {
    const state = this.peers.get(peer);
    if (!state) return 0;

    // Quality is based on:
    // 1. How many novel blocks they send us (receivedFirst size)
    // 2. Reciprocity
    const novelty = state.receivedFirst.size;
    const reciprocity = this.getReciprocity(peer);
    return novelty * Math.min(reciprocity, 2);
  }

  // -- Fetch Interface ----------------------------------------------

  /**
   * Find the best peer to fetch a block from.
   * Prefers peers whose awareness includes the block.
   * Falls back to the most well-connected peer.
   */
  bestPeerForFetch(hash: Hash): string | undefined {
    // 1. Prefer peers known to have the block
    for (const [peerId, state] of this.peers) {
      if (state.awareness.has(hash)) return peerId;
    }

    // 2. Fall back to peer with largest receivedFirst set (most connected)
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
   * Should be called periodically to let the module adapt to topology changes.
   */
  decayMatrices(): void {
    const { matrixDecayFactor, reciprocityDecayFactor } = this.config;
    for (const [, state] of this.peers) {
      // Decay delivery matrix
      for (const [, entry] of state.deliveryMatrix) {
        entry.alpha *= matrixDecayFactor;
        entry.beta *= matrixDecayFactor;
      }
      // Decay reciprocity accumulators
      state.utilitySent *= reciprocityDecayFactor;
      state.utilityReceived *= reciprocityDecayFactor;
    }
  }
}

// --- Utilities ---

/** Standard sigmoid function. Maps (-∞, ∞) to (0, 1). */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
