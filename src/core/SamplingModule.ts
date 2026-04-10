// Protocol spec: docs/protocol/sampling.md

import { Hash, HashPrimitive } from '../util/Hash.ts';

// -- Provider -------------------------------------------------------

/** Provider interface for the sampling module to access block data. */
export interface SamplingProvider<BlockType> {
  /** Return the block for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the hash of a block. */
  getHash(block: BlockType): Hash;

  /** Return the hashes of blocks this block aggregates. */
  getAggregates(block: BlockType): Hash[];

  /** Return the block's own verification cost (excluding subtrees). */
  getSelfWeight(block: BlockType): number;

  /**
   * Return the subtree weights for each aggregate, as known by the parent block.
   * These weights are available even when the aggregate blocks themselves are missing,
   * because they come from the parent's aggregation cache.
   */
  getAggregateWeights(block: BlockType): number[];
}

// -- Types ----------------------------------------------------------

/** Per-block sample state tracking sample history and verification outcomes. */
export interface BlockSampleState {
  /** Sample log: -1 = self (terminal), i = aggregate index. */
  readonly queries: number[];
  /** Whether this block's own verification passed. */
  selfVerified: boolean;
}

/** Result of initiating a sample on a block. */
export type SampleResult =
  | { terminal: true; blockHash: Hash }
  | { terminal: false; reason: 'missing' | 'no_weight' | 'reused' };

/**
 * Conflict info for a tree, used to compute expected canonicality change.
 * The priority multiplier is: contested_weight / max(gap, epsilon).
 */
export interface SamplingConflictInfo {
  /** The absolute weight gap to the closest conflict rival. */
  weightGap: number;
  /** Sum of this tree's weight and the rival's weight. */
  contestedWeight: number;
}

// -- Module ---------------------------------------------------------

/**
 * The sampling module implements recursive weight sampling for the protocol.
 *
 * It maintains per-block sample state, descends through aggregation trees
 * proportionally to weight, and computes a weight factor (responses/queries)
 * that scales declared weight to verified weight.
 *
 * Fully self-contained -- depends only on SamplingProvider and Hash.
 */
export class SamplingModule<BlockType> {
  private readonly _provider: SamplingProvider<BlockType>;

  /** Per-block sample state, keyed by hash primitive. */
  private readonly _states = new Map<HashPrimitive, BlockSampleState>();

  /** Registered block hashes. */
  private readonly _blocks = new Map<HashPrimitive, Hash>();

  /** Listeners for weight factor changes. */
  private readonly _weightListeners: ((hash: Hash) => void)[] = [];

  /** Optional: conflict info supplier for canonicality change multiplier. */
  private _conflictInfo?: (hash: Hash) => SamplingConflictInfo | undefined;

  /** Optional: random number generator (defaults to Math.random). */
  private _random: () => number = Math.random;

  constructor(provider: SamplingProvider<BlockType>, random?: () => number) {
    this._provider = provider;
    if (random) this._random = random;
  }

  // -- Configuration ------------------------------------------------

  /** Set the conflict info supplier for priority canonicality change multiplier. */
  setConflictInfoSupplier(supplier: (hash: Hash) => SamplingConflictInfo | undefined): void {
    this._conflictInfo = supplier;
  }

  // -- Listeners ----------------------------------------------------

  /** Register a listener for weight factor changes. */
  onWeightChange(cb: (hash: Hash) => void): void {
    this._weightListeners.push(cb);
  }

  // -- Mutations ----------------------------------------------------

  /** Register a block for sampling. Creates initial sample state. */
  addBlock(hash: Hash): void {
    const key = hash.toPrimitive();
    if (this._states.has(key)) return;

    const block = this._provider.getBlock(hash);
    if (!block) return;

    this._states.set(key, {
      queries: [],
      selfVerified: false,
    });
    this._blocks.set(key, hash);
  }

  /** Remove a block from sampling. */
  removeBlock(hash: Hash): void {
    const key = hash.toPrimitive();
    this._states.delete(key);
    this._blocks.delete(key);
  }

  /**
   * Initiate a sample on a block. Randomly descends through the aggregation
   * tree proportionally to weight until a terminal is reached.
   *
   * Returns the terminal block to verify, or a reason the sample could not
   * complete (missing block, zero weight, or reused existing sample).
   */
  initSample(hash: Hash): SampleResult {
    const key = hash.toPrimitive();
    let state = this._states.get(key);

    // If we don't have state for this block yet, try to create it
    if (!state) {
      this.addBlock(hash);
      state = this._states.get(key);
    }
    if (!state) {
      return { terminal: false, reason: 'missing' };
    }

    const block = this._provider.getBlock(hash);
    if (!block) {
      return { terminal: false, reason: 'missing' };
    }

    // Query weights dynamically from the provider each time
    const selfWeight = this._provider.getSelfWeight(block);
    const aggregateWeights = this._provider.getAggregateWeights(block);
    const totalWeight = selfWeight + aggregateWeights.reduce((a, b) => a + b, 0);

    if (totalWeight <= 0) {
      return { terminal: false, reason: 'no_weight' };
    }

    // Random descent proportional to weight
    let sampleAt = this._random() * totalWeight;
    const aggregates = this._provider.getAggregates(block);
    for (let i = 0; i < aggregateWeights.length; i++) {
      const w = aggregateWeights[i];
      if (sampleAt < w) {
        // Sample descends into aggregate i
        state.queries.push(i);

        const aggHash = aggregates[i];

        // Ensure the aggregate has enough samples to match what we've sent
        const requestedCount = state.queries.filter((q) => q === i).length;
        const aggState = this._states.get(aggHash.toPrimitive());

        if (!aggState || aggState.queries.length < requestedCount) {
          // Recurse into the aggregate to generate a new sample
          return this.initSample(aggHash);
        }

        // Aggregate already has enough samples -- reuse existing result.
        // The query is recorded and will be counted via countVerifications.
        return { terminal: false, reason: 'reused' };
      }
      sampleAt -= w;
    }

    // Self-weight was selected: this block is the terminal
    state.queries.push(-1);
    return { terminal: true, blockHash: hash };
  }

  /**
   * Record verification result for a terminal block.
   * Sets selfVerified and notifies listeners.
   */
  recordVerification(hash: Hash, success: boolean): void {
    const state = this._states.get(hash.toPrimitive());
    if (!state) return;

    if (success) {
      state.selfVerified = true;
    }

    // Notify listeners
    for (const cb of this._weightListeners) cb(hash);
  }

  // -- Queries ------------------------------------------------------

  /** Get the sample state for a block. */
  getSampleState(hash: Hash): BlockSampleState | undefined {
    return this._states.get(hash.toPrimitive());
  }

  /**
   * Compute the weight factor for a block: verified responses / total queries.
   * Returns 0 when no queries have been made (pessimistic default).
   */
  getWeightFactor(hash: Hash): number {
    const state = this._states.get(hash.toPrimitive());
    if (!state || state.queries.length === 0) return 0;

    const verified = this.countVerifications(hash, state.queries.length);
    return verified / state.queries.length;
  }

  /**
   * Recursively count verified terminals, bounded by a limit.
   *
   * The limit ensures that a parent sampling a child N times only counts
   * N of the child's results, preventing heavily-sampled subtrees from
   * inflating their parent's confidence.
   */
  countVerifications(hash: Hash, limit: number): number {
    const state = this._states.get(hash.toPrimitive());
    if (!state) return 0;

    // Only consider the first `limit` queries at this level
    const queries = state.queries.slice(0, limit);
    let verifications = 0;

    // Count verified terminals in each aggregate subtree
    const blockHash = this._blocks.get(hash.toPrimitive());
    const block = blockHash ? this._provider.getBlock(blockHash) : undefined;
    if (block) {
      const aggregates = this._provider.getAggregates(block);
      for (let i = 0; i < aggregates.length; i++) {
        const sampleCount = queries.filter((q) => q === i).length;
        if (sampleCount === 0) continue;
        verifications += this.countVerifications(aggregates[i], sampleCount);
      }
    }

    // Count self-queries (only if self-verified)
    if (state.selfVerified) {
      verifications += queries.filter((q) => q === -1).length;
    }

    return verifications;
  }

  /** Get total weight for a block (self + aggregates), queried dynamically. */
  getTotalWeight(hash: Hash): number {
    const block = this._provider.getBlock(hash);
    if (!block) return 0;
    const selfWeight = this._provider.getSelfWeight(block);
    const aggregateWeights = this._provider.getAggregateWeights(block);
    return selfWeight + aggregateWeights.reduce((a, b) => a + b, 0);
  }

  /**
   * Compute the scheduling priority for a block.
   *
   * Base priority is the expected weight swing from one sample:
   *   swing = 2I(r+1)(q-r+1) / [(q+2)^2(q+3)]
   *
   * For trees in a conflict, priority is the expected canonicality change:
   *   priority = swing * contested_weight / max(gap, epsilon)
   *
   * This represents "how much canonical weight could shift from one sample."
   * Two large trees with a small gap have a very high expected change.
   */
  getPriority(hash: Hash): number {
    const state = this._states.get(hash.toPrimitive());
    if (!state) return 0;

    const q = state.queries.length;
    const r = q > 0 ? this.countVerifications(hash, q) : 0;
    const incentive = this.getTotalWeight(hash);

    if (incentive <= 0) return 0;

    // Expected weight swing: 2I(r+1)(q-r+1) / [(q+2)^2(q+3)]
    const alpha = r + 1;
    const beta = q - r + 1;
    const s = alpha + beta; // = q + 2
    const swing = (2 * incentive * alpha * beta) / (s * s * (s + 1));

    // Expected canonicality change multiplier
    if (this._conflictInfo) {
      const info = this._conflictInfo(hash);
      if (info) {
        const epsilon = 1; // minimum gap to avoid division by zero
        return swing * info.contestedWeight / Math.max(info.weightGap, epsilon);
      }
    }

    return swing;
  }

  /** Select the highest-priority block to sample next, or undefined if none. */
  selectNext(): Hash | undefined {
    let bestHash: Hash | undefined;
    let bestPriority = -1;

    for (const [key] of this._states) {
      const hash = this._blocks.get(key);
      if (!hash) continue;
      const priority = this.getPriority(hash);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestHash = hash;
      }
    }

    return bestHash;
  }
}
