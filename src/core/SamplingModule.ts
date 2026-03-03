import { Hash, HashPrimitive } from '../util/Hash.ts';

/** Provider interface for the sampling module to access tree data. */
export interface SamplingProvider<BlockType> {
  /** Return the block for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the declared work of the tree rooted at this block. */
  getDeclaredWork(block: BlockType): number;

  /** Return the verified descendant weight of the tree (from the consensus module). */
  getDescendantWeight(block: BlockType): number;
}

/** Beta distribution parameters representing belief about a tree's work authenticity. */
export interface WorkDistribution {
  /** Successful samples (alpha parameter). */
  readonly successes: number;
  /** Failed samples including pending (beta - 1 parameter). */
  readonly failures: number;
  /** Expected value of the realness fraction: n / (n + f + 1). */
  readonly mean: number;
}

/** Snapshot of a tree's full sampling state. */
export interface TreeSamplingState {
  /** The tree's root block hash. */
  readonly hash: Hash;
  /** Declared work of the tree. */
  readonly declaredWork: number;
  /** The output Beta distribution. */
  readonly distribution: WorkDistribution;
  /** Verified weight: W * mean. */
  readonly verifiedWork: number;
  /** Current sampling priority score. */
  readonly priority: number;
}

/**
 * The sampling module determines which trees to verify and maintains a
 * statistical model of each tree's work authenticity.
 *
 * It outputs a Beta distribution per tree, consumed by the consensus module
 * for weight computation and used internally for verification prioritization.
 *
 * Fully self-contained -- depends only on SamplingProvider and Hash.
 */
export class SamplingModule<BlockType> {
  private readonly _provider: SamplingProvider<BlockType>;

  /** Per-tree sampling state: successes and failures (including pending). */
  private _trees = new Map<HashPrimitive, { n: number; f: number }>();

  constructor(provider: SamplingProvider<BlockType>) {
    this._provider = provider;
  }

  /** Register a tree to be tracked for sampling. */
  addTree(hash: Hash): void {
    const key = hash.toPrimitive();
    if (this._trees.has(key)) return;
    this._trees.set(key, { n: 0, f: 0 });
  }

  /** Record that a sample has been requested (counts as pending/failure). */
  recordSampleRequested(treeHash: Hash): void {
    const state = this._trees.get(treeHash.toPrimitive());
    if (!state) return;
    state.f += 1;
  }

  /** Record that a pending sample succeeded. Flips one failure to a success. */
  recordSampleSuccess(treeHash: Hash): void {
    const state = this._trees.get(treeHash.toPrimitive());
    if (!state) return;
    state.n += 1;
    state.f -= 1;
  }

  /** Record that a pending sample failed (no state change -- already counted). */
  recordSampleFailure(_treeHash: Hash): void {
    // Intentionally empty: pending samples are already counted as failures.
  }

  /** Get the work distribution for a tree. Returns Beta(n, f+1) parameters. */
  getDistribution(treeHash: Hash): WorkDistribution | undefined {
    const state = this._trees.get(treeHash.toPrimitive());
    if (!state) return undefined;
    const { n, f } = state;
    const mean = n === 0 ? 0 : n / (n + f + 1);
    return { successes: n, failures: f, mean };
  }

  /** Get the verified work for a tree: W * n / (n + f + 1). */
  getVerifiedWork(treeHash: Hash): number {
    const block = this._provider.getBlock(treeHash);
    if (!block) return 0;
    const state = this._trees.get(treeHash.toPrimitive());
    if (!state) return 0;
    const { n, f } = state;
    if (n === 0) return 0;
    return this._provider.getDeclaredWork(block) * n / (n + f + 1);
  }

  /**
   * Compute the sampling priority for a tree.
   *
   * priority = 2W(n+1)(f+1) / [(s+2)^2(s+3)] * W / (W+D)
   *
   * Uses proper Beta(n+1, f+1) for information value (how much could we learn),
   * not the pessimistic output prior.
   */
  getPriority(treeHash: Hash): number {
    const block = this._provider.getBlock(treeHash);
    if (!block) return 0;
    const state = this._trees.get(treeHash.toPrimitive());
    if (!state) return 0;

    const w = this._provider.getDeclaredWork(block);
    const d = this._provider.getDescendantWeight(block);
    const { n, f } = state;
    const s = n + f;

    const swing = 2 * w * (n + 1) * (f + 1) / ((s + 2) * (s + 2) * (s + 3));
    const dampening = w / (w + d);
    return swing * dampening;
  }

  /** Get full sampling state snapshot for a tree. */
  getState(treeHash: Hash): TreeSamplingState | undefined {
    const block = this._provider.getBlock(treeHash);
    if (!block) return undefined;
    if (!this._trees.has(treeHash.toPrimitive())) return undefined;

    const distribution = this.getDistribution(treeHash)!;
    return {
      hash: treeHash,
      declaredWork: this._provider.getDeclaredWork(block),
      distribution,
      verifiedWork: this.getVerifiedWork(treeHash),
      priority: this.getPriority(treeHash),
    };
  }

  /** Select the highest-priority tree to sample next, or undefined if none. */
  selectNext(): Hash | undefined {
    let bestHash: Hash | undefined;
    let bestPriority = -1;

    for (const [key] of this._trees) {
      const hash = Hash.fromPrimitive(key);
      const priority = this.getPriority(hash);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestHash = hash;
      }
    }

    return bestHash;
  }
}
