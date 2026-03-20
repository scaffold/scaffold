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
 * (positions 0,2,4,... survive; the 1st survivor is position 2)
 */
export function mapSurvivingToOriginal(
  survivingIndex: number,
  claimMask: readonly number[],
): number {
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
 * Map an original (pre-claim) index to its surviving (post-claim) index.
 * Returns -1 if the index was claimed (removed).
 * claimMask is a sorted array of removed positions.
 */
export function mapOriginalToSurviving(
  originalIndex: number,
  claimMask: readonly number[],
): number {
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
 */
export function unionClaimMasks(
  a: readonly number[],
  b: readonly number[],
): number[] {
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

    const ownOutputCount = block.outputs.length;
    const totalAggOutputs = block.aggregateOutputCounts.reduce((a, b) => a + b, 0);
    const inheritedOffset = ownOutputCount + totalAggOutputs;

    const ownAnchorClaims: number[] = [];
    for (const idx of block.claims) {
      if (idx < ownOutputCount) continue;
      if (idx < inheritedOffset) continue;

      const survivingIdx = idx - inheritedOffset;
      const originalIdx = mapSurvivingToOriginal(survivingIdx, aggMask);
      ownAnchorClaims.push(originalIdx);
    }

    ownAnchorClaims.sort((a, b) => a - b);
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

    for (let i = 0; i < block.outputs.length; i++) {
      entries.push({ block: blockHash, outputIndex: i, spaceIndex: idx++ });
    }

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

    if (!Hash.equals(block.anchor, ZERO_HASH)) {
      const anchorSpace = this.outputSpace(block.anchor);
      if (!anchorSpace) return undefined;

      const aggMask = this._aggregateClaimMask(block);
      const aggMaskSet = new Set(aggMask);

      for (let i = 0; i < anchorSpace.length; i++) {
        if (aggMaskSet.has(i)) continue;
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

    const claimSet = new Set(block.claims);
    const result: UtxoEntry[] = [];
    let spaceIdx = 0;
    for (const entry of extended) {
      if (!claimSet.has(entry.spaceIndex)) {
        result.push({ ...entry, spaceIndex: spaceIdx++ });
      }
    }

    return result;
  }

  // -- Internal ---------------------------------------------------

  /**
   * Compute the combined claim mask that aggregate subtrees make against
   * the block's anchor's output space. Walks each aggregate's subtree,
   * resolves every non-self claim, and checks if the resolved output
   * lives in the anchor's output space.
   */
  private _aggregateClaimMask(block: OutputSpaceBlock): number[] {
    if (block.aggregates.length === 0) return [];

    const anchorHash = block.anchor;
    const mask: number[] = [];

    for (const aggHash of block.aggregates) {
      const sub = this.subtreeFrom(aggHash, anchorHash);
      for (const bHash of sub) {
        const b = this.provider.getBlock(bHash);
        if (!b) continue;
        for (const claimIdx of b.claims) {
          if (claimIdx < b.outputs.length) continue;
          const resolved = this.resolveClaimIndex(bHash, claimIdx);
          if (!resolved) continue;
          const anchorIdx = this.computeOutputSpaceIndex(anchorHash, resolved);
          if (anchorIdx !== undefined) {
            mask.push(anchorIdx);
          }
        }
      }
    }

    mask.sort((a, b) => a - b);
    const deduped: number[] = [];
    for (const v of mask) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== v) {
        deduped.push(v);
      }
    }
    return deduped;
  }
}
