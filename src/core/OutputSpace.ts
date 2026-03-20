// Protocol spec: docs/protocol/output-space.md, docs/protocol/aggregation.md

import { Hash, ZERO_HASH } from '../util/Hash.ts';

// -- Types --------------------------------------------------------

/** Minimal block view needed for output-space operations. */
export interface OutputSpaceBlock {
  readonly hash: Hash;
  readonly anchor: Hash;
  readonly aggregates: readonly Hash[];
  readonly outputs: ReadonlyArray<{ readonly value: number }>;
  /** Sorted claim indices into this block's extended vector. */
  readonly claims: readonly number[];
  /** Per-aggregate newOutputCount values (from cache). Same order as aggregates. */
  readonly aggregateOutputCounts: readonly number[];
  /**
   * Total new surviving outputs contributed by this block's subtree.
   * For leaf blocks: outputs.length - selfClaimCount.
   * For aggregation blocks: from AggregationData.newOutputCount.
   */
  readonly newOutputCount: number;
}

/** Provider interface for the OutputSpaceModule. */
export interface OutputSpaceProvider {
  getBlock(hash: Hash): OutputSpaceBlock | undefined;
}

/** A resolved output: which block produced it and at what local index. */
export interface ResolvedOutput {
  readonly block: Hash;
  readonly outputIndex: number;
}

/** An output in the output space with provenance. */
export interface UtxoEntry {
  /** Block that produced this output. */
  readonly block: Hash;
  /** Index in the producing block's outputs array. */
  readonly outputIndex: number;
  /** Index in the owning block's output space. */
  readonly spaceIndex: number;
}

/** Claim mask: sorted array of anchor output indices. */
export type ClaimMask = number[];

// -- Sorted Array Helpers -----------------------------------------

/**
 * Map a surviving (post-claim) index to the original (pre-claim) index.
 * claimMask is a sorted array of removed positions.
 *
 * Example: claimMask=[1,3], survivingIndex=1 → original index 2
 */
export function mapSurvivingToOriginal(
  survivingIndex: number,
  claimMask: readonly number[],
): number {
  if (claimMask.length === 0) return survivingIndex;

  let original = 0;
  let survived = 0;
  let maskIdx = 0;

  while (survived <= survivingIndex) {
    while (maskIdx < claimMask.length && claimMask[maskIdx] === original) {
      original++;
      maskIdx++;
    }
    if (survived === survivingIndex) return original;
    survived++;
    original++;
  }

  return original;
}

/**
 * Batch version: map a sorted array of surviving indices to original indices.
 * Both inputs sorted, output sorted. O(n + m) single-pass merge.
 */
export function mapSurvivingToOriginalBatch(
  survivingIndices: readonly number[],
  claimMask: readonly number[],
): number[] {
  if (survivingIndices.length === 0) return [];
  if (claimMask.length === 0) return [...survivingIndices];

  const result: number[] = [];
  let original = 0;
  let survived = 0;
  let maskIdx = 0;
  let inputIdx = 0;

  while (inputIdx < survivingIndices.length) {
    // Skip over claimed positions
    while (maskIdx < claimMask.length && claimMask[maskIdx] === original) {
      original++;
      maskIdx++;
    }
    // If this surviving position matches, record it
    if (survived === survivingIndices[inputIdx]) {
      result.push(original);
      inputIdx++;
    }
    survived++;
    original++;
  }

  return result;
}

/**
 * Map an original (pre-claim) index to its surviving (post-claim) index.
 * Returns -1 if the index was claimed (removed).
 * Uses binary search on the sorted claimMask: O(log m).
 */
export function mapOriginalToSurviving(
  originalIndex: number,
  claimMask: readonly number[],
): number {
  if (claimMask.length === 0) return originalIndex;

  // Binary search for the insertion point
  let lo = 0;
  let hi = claimMask.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (claimMask[mid] < originalIndex) lo = mid + 1;
    else hi = mid;
  }
  if (lo < claimMask.length && claimMask[lo] === originalIndex) return -1;
  return originalIndex - lo;
}

/**
 * Check if two sorted claim masks overlap (share any index).
 * O(n + m) merge walk.
 */
export function claimMasksOverlap(
  a: readonly number[],
  b: readonly number[],
): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) return true;
    if (a[i] < b[j]) i++;
    else j++;
  }
  return false;
}

/**
 * Union two sorted claim masks into a new sorted array.
 * O(n + m) merge.
 */
export function unionClaimMasks(
  a: readonly number[],
  b: readonly number[],
): number[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];

  const result: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) result.push(a[i++]);
    else if (a[i] > b[j]) result.push(b[j++]);
    else { result.push(a[i]); i++; j++; }
  }
  while (i < a.length) result.push(a[i++]);
  while (j < b.length) result.push(b[j++]);
  return result;
}

/**
 * From a sorted array, drop values below threshold and subtract threshold
 * from the rest. Output is sorted since input is sorted and shift is uniform.
 *
 * Example: filterAboveAndShift([1, 3, 5, 7], 3) → [0, 2, 4]
 */
export function filterAboveAndShift(
  sorted: readonly number[],
  threshold: number,
): number[] {
  // Binary search for first index >= threshold
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < threshold) lo = mid + 1;
    else hi = mid;
  }

  const result = new Array(sorted.length - lo);
  for (let i = lo; i < sorted.length; i++) {
    result[i - lo] = sorted[i] - threshold;
  }
  return result;
}

// -- Module -------------------------------------------------------

/**
 * Pure output-space logic. Encapsulates all claim index transformation,
 * ordering, claim mask computation, and UTXO set operations.
 *
 * Fully self-contained -- depends only on OutputSpaceProvider and Hash.
 */
export class OutputSpaceModule {
  constructor(private readonly provider: OutputSpaceProvider) {}

  // -- DAG Ordering -----------------------------------------------

  /**
   * Compute the subtree ordering from base (exclusive) to tip (inclusive).
   * Follows both anchor chains and aggregate chains, stopping at base.
   */
  subtreeFrom(tip: Hash, base: Hash): Hash[] {
    if (Hash.equals(tip, base)) return [];

    const block = this.provider.getBlock(tip);
    if (!block) return [];

    const result: Hash[] = [];

    if (!Hash.equals(block.anchor, ZERO_HASH)) {
      result.push(...this.subtreeFrom(block.anchor, base));
    }

    for (const agg of block.aggregates) {
      result.push(...this.subtreeFrom(agg, base));
    }

    result.push(tip);
    return result;
  }

  /**
   * Compute the full total ordering ending at tip (including genesis).
   */
  totalOrdering(tip: Hash): Hash[] {
    const block = this.provider.getBlock(tip);
    if (!block) return [];

    if (Hash.equals(block.anchor, ZERO_HASH)) return [tip];

    return [
      ...this.totalOrdering(block.anchor),
      ...block.aggregates.flatMap((a) => this.subtreeFrom(a, block.anchor)),
      tip,
    ];
  }

  // -- Claim Index Resolution -------------------------------------

  /**
   * Resolve a claim index in block's extended vector to the producing block.
   *
   * Extended vector: [own outputs, agg[n-1].new, ..., agg[0].new, anchor.surviving]
   */
  resolveClaimIndex(blockHash: Hash, claimIndex: number): ResolvedOutput | undefined {
    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    if (claimIndex < block.outputs.length) {
      return { block: blockHash, outputIndex: claimIndex };
    }

    let remaining = claimIndex - block.outputs.length;

    for (let i = block.aggregates.length - 1; i >= 0; i--) {
      const count = block.aggregateOutputCounts[i];
      if (remaining < count) {
        return this.resolveOutputSpaceIndex(block.aggregates[i], remaining);
      }
      remaining -= count;
    }

    const aggMask = this._aggregateClaimMask(block);
    const anchorSpaceIdx = mapSurvivingToOriginal(remaining, aggMask);
    return this.resolveOutputSpaceIndex(block.anchor, anchorSpaceIdx);
  }

  /**
   * Resolve an index in block's output space (post-claims) to the producing block.
   * Maps through claim gaps to get the extended vector index, then delegates
   * to resolveClaimIndex.
   */
  resolveOutputSpaceIndex(blockHash: Hash, spaceIndex: number): ResolvedOutput | undefined {
    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    const extIdx = mapSurvivingToOriginal(spaceIndex, block.claims);
    return this.resolveClaimIndex(blockHash, extIdx);
  }

  // -- Inverse: Compute Claim Index -------------------------------

  /**
   * Compute the claim index in block's extended vector for a known output.
   * Inverse of resolveClaimIndex.
   */
  computeClaimIndex(blockHash: Hash, target: ResolvedOutput): number | undefined {
    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    if (Hash.equals(target.block, blockHash)) {
      if (target.outputIndex < block.outputs.length) {
        return target.outputIndex;
      }
      return undefined;
    }

    // Only match if in the aggregate's NEW outputs (< aggregateOutputCounts[i])
    let offset = block.outputs.length;
    for (let i = block.aggregates.length - 1; i >= 0; i--) {
      const spaceIdx = this.computeOutputSpaceIndex(block.aggregates[i], target);
      if (spaceIdx !== undefined && spaceIdx < block.aggregateOutputCounts[i]) {
        return offset + spaceIdx;
      }
      offset += block.aggregateOutputCounts[i];
    }

    // Anchor portion uses surviving indices (post-subtree-claims)
    const anchorSpaceIdx = this.computeOutputSpaceIndex(block.anchor, target);
    if (anchorSpaceIdx !== undefined) {
      const aggMask = this._aggregateClaimMask(block);
      const survivingIdx = mapOriginalToSurviving(anchorSpaceIdx, aggMask);
      if (survivingIdx === -1) return undefined;
      return offset + survivingIdx;
    }

    return undefined;
  }

  /**
   * Compute the output space index for a known output in a block.
   * Inverse of resolveOutputSpaceIndex.
   */
  computeOutputSpaceIndex(blockHash: Hash, target: ResolvedOutput): number | undefined {
    const extIdx = this.computeClaimIndex(blockHash, target);
    if (extIdx === undefined) return undefined;

    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    const result = mapOriginalToSurviving(extIdx, block.claims);
    return result === -1 ? undefined : result;
  }

  // -- Claim Masks ------------------------------------------------

  /**
   * Compute the claim mask for a block's subtree against its anchor's output space.
   * Returns a sorted array of anchor output indices that the subtree claims.
   * Self-claims are excluded.
   */
  subtreeClaimMask(blockHash: Hash): ClaimMask | undefined {
    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    const aggMask = this._aggregateClaimMask(block);

    // Extract own claims that hit anchor's surviving outputs:
    // claims >= (ownOutputCount + totalAggOutputs) target the anchor portion
    const inheritedOffset = block.outputs.length +
      block.aggregateOutputCounts.reduce((a, b) => a + b, 0);

    const shifted = filterAboveAndShift(block.claims, inheritedOffset);
    const ownAnchorClaims = mapSurvivingToOriginalBatch(shifted, aggMask);

    return unionClaimMasks(aggMask, ownAnchorClaims);
  }

  // -- Output Space Computation -----------------------------------

  /**
   * Compute the extended vector of a block (before claims are applied).
   * Layout: [own outputs, agg[n-1].new, ..., agg[0].new, anchor.surviving]
   */
  extendedVector(blockHash: Hash): UtxoEntry[] | undefined {
    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    const entries: UtxoEntry[] = [];
    let idx = 0;

    // Own outputs
    for (let i = 0; i < block.outputs.length; i++) {
      entries.push({ block: blockHash, outputIndex: i, spaceIndex: idx++ });
    }

    // Aggregate new outputs (reverse order)
    for (let i = block.aggregates.length - 1; i >= 0; i--) {
      const aggSpace = this.outputSpace(block.aggregates[i]);
      if (!aggSpace) return undefined;

      const newCount = block.aggregateOutputCounts[i];
      for (let j = 0; j < newCount && j < aggSpace.length; j++) {
        entries.push({
          block: aggSpace[j].block,
          outputIndex: aggSpace[j].outputIndex,
          spaceIndex: idx++,
        });
      }
    }

    // Anchor's surviving outputs — merge-walk with sorted aggMask
    if (!Hash.equals(block.anchor, ZERO_HASH)) {
      const anchorSpace = this.outputSpace(block.anchor);
      if (!anchorSpace) return undefined;

      const aggMask = this._aggregateClaimMask(block);
      let maskPtr = 0;

      for (let i = 0; i < anchorSpace.length; i++) {
        // Advance mask pointer past positions below i
        while (maskPtr < aggMask.length && aggMask[maskPtr] < i) maskPtr++;
        if (maskPtr < aggMask.length && aggMask[maskPtr] === i) continue;

        entries.push({
          block: anchorSpace[i].block,
          outputIndex: anchorSpace[i].outputIndex,
          spaceIndex: idx++,
        });
      }
    }

    return entries;
  }

  /**
   * Compute the output space of a block: surviving outputs after all claims.
   * Layout: [surviving own, agg[n-1].new, ..., agg[0].new, anchor.surviving]
   */
  outputSpace(blockHash: Hash): UtxoEntry[] | undefined {
    const extended = this.extendedVector(blockHash);
    if (!extended) return undefined;

    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    // Merge-walk: extended entries have sequential spaceIndex (0,1,2,...),
    // claims is sorted — use a pointer instead of Set
    const claims = block.claims;
    let claimPtr = 0;

    const result: UtxoEntry[] = [];
    let spaceIdx = 0;
    for (const entry of extended) {
      while (claimPtr < claims.length && claims[claimPtr] < entry.spaceIndex) claimPtr++;
      if (claimPtr < claims.length && claims[claimPtr] === entry.spaceIndex) {
        continue;
      }
      result.push({ ...entry, spaceIndex: spaceIdx++ });
    }

    return result;
  }

  // -- Rebase -----------------------------------------------------

  /**
   * Rebase a block's subtree claim mask from its own anchor to a target ancestor.
   * Walks from block.anchor up to targetAnchor, rebasing at each step.
   * Returns null if the chain can't be walked.
   */
  rebaseClaimMask(blockHash: Hash, targetAnchor: Hash): number[] | null {
    return this._rebaseClaimMaskInner(blockHash, targetAnchor, true);
  }

  /**
   * Rebase a block's subtree claim mask exclusively -- projecting only the
   * block's own claims through intermediates without accumulating intermediate
   * blocks' claims. Intermediate claim masks are used for gap-mapping only.
   *
   * Use this when aggregates may be in each other's anchor chains; each
   * aggregate reports only its own contribution, avoiding double-counting.
   */
  rebaseClaimMaskExclusive(blockHash: Hash, targetAnchor: Hash): number[] | null {
    return this._rebaseClaimMaskInner(blockHash, targetAnchor, false);
  }

  /**
   * Shared rebase implementation.
   *
   * @param accumulate - When true, unions intermediate blocks' subtree claim
   *   masks into the result (full subtree rebase). When false, only projects
   *   the starting block's claims through intermediates (exclusive rebase).
   */
  private _rebaseClaimMaskInner(
    blockHash: Hash,
    targetAnchor: Hash,
    accumulate: boolean,
  ): number[] | null {
    const block = this.provider.getBlock(blockHash);
    if (!block) return null;

    let mask = this.subtreeClaimMask(blockHash) ?? [];

    // If already at target, no rebase needed
    if (Hash.equals(block.anchor, targetAnchor)) return mask;

    // Walk from block.anchor toward targetAnchor
    let current = block.anchor;
    while (!Hash.equals(current, targetAnchor)) {
      const curBlock = this.provider.getBlock(current);
      if (!curBlock) return null;

      const curMask = this.subtreeClaimMask(current) ?? [];
      const inherited = filterAboveAndShift(mask, curBlock.newOutputCount);
      const rebased = mapSurvivingToOriginalBatch(inherited, curMask);
      mask = accumulate ? unionClaimMasks(rebased, curMask) : rebased;
      current = curBlock.anchor;
    }

    return mask;
  }

  // -- Internal ---------------------------------------------------

  /**
   * Compute the combined claim mask that aggregate subtrees make against
   * the block's anchor's output space.
   *
   * For each aggregate, takes its subtreeClaimMask (against its own anchor)
   * and rebases it through the chain of intermediate blocks up to this
   * block's anchor. Only requires the subtree root's claim masks, not a
   * walk of the full subtree.
   */
  private _aggregateClaimMask(block: OutputSpaceBlock): number[] {
    if (block.aggregates.length === 0) return [];

    let result: number[] = [];

    for (const aggHash of block.aggregates) {
      const mask = this.rebaseClaimMask(aggHash, block.anchor);
      if (mask) {
        result = unionClaimMasks(result, mask);
      }
    }

    return result;
  }
}
