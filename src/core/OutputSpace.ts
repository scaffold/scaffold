// Protocol spec: docs/protocol/output-space.md, docs/protocol/aggregation.md

import { Hash, ZERO_HASH } from '../util/Hash.ts';

// -- Types --------------------------------------------------------

/** Minimal block data needed for output-space operations. */
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

/** Lookup function for block data. */
export type OutputSpaceLookup = (hash: Hash) => OutputSpaceBlock | undefined;

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
    // Skip over claimed positions
    while (maskIdx < claimMask.length && claimMask[maskIdx] === original) {
      original++;
      maskIdx++;
    }
    if (survived === survivingIndex) return original;
    survived++;
    original++;
  }

  return original; // Should not reach here for valid input
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
  // Check if this index was claimed
  let lo = 0;
  let hi = claimMask.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (claimMask[mid] < originalIndex) lo = mid + 1;
    else hi = mid;
  }
  if (lo < claimMask.length && claimMask[lo] === originalIndex) return -1;

  // Count how many claimed indices are below originalIndex
  // lo is already the count of mask entries < originalIndex (from the binary search)
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

// -- DAG Ordering -------------------------------------------------

/**
 * Compute the subtree ordering from base (exclusive) to tip (inclusive).
 * Follows both anchor chains and aggregate chains, stopping at base.
 *
 * subtreeFrom(block, base) =
 *   if block == base: []
 *   else: [...subtreeFrom(block.anchor, base),
 *          ...block.aggregates.flatMap(a => subtreeFrom(a, base)),
 *          block]
 */
export function subtreeFrom(
  tip: Hash,
  base: Hash,
  lookup: OutputSpaceLookup,
): Hash[] {
  if (Hash.equals(tip, base)) return [];

  const block = lookup(tip);
  if (!block) return [];

  const result: Hash[] = [];

  // Follow anchor chain
  if (!Hash.equals(block.anchor, ZERO_HASH)) {
    result.push(...subtreeFrom(block.anchor, base, lookup));
  }

  // Follow aggregate chains
  for (const agg of block.aggregates) {
    result.push(...subtreeFrom(agg, base, lookup));
  }

  result.push(tip);
  return result;
}

/**
 * Compute the full total ordering ending at tip (including genesis).
 */
export function totalOrdering(
  tip: Hash,
  lookup: OutputSpaceLookup,
): Hash[] {
  const block = lookup(tip);
  if (!block) return [];

  // Genesis: anchor is ZERO_HASH
  if (Hash.equals(block.anchor, ZERO_HASH)) return [tip];

  return [
    ...totalOrdering(block.anchor, lookup),
    ...block.aggregates.flatMap((a) => subtreeFrom(a, block.anchor, lookup)),
    tip,
  ];
}

// -- Claim Index Resolution ---------------------------------------

/**
 * Resolve a claim index in block's extended vector to the producing block.
 *
 * Extended vector: [own outputs, agg[n-1].new, ..., agg[0].new, anchor.surviving]
 * - I < outputs.length → self-claim: {block, I}
 * - else → navigate through aggregates (reverse order) then anchor
 */
export function resolveClaimIndex(
  blockHash: Hash,
  claimIndex: number,
  lookup: OutputSpaceLookup,
): ResolvedOutput | undefined {
  const block = lookup(blockHash);
  if (!block) return undefined;

  // Self-claim or own output
  if (claimIndex < block.outputs.length) {
    return { block: blockHash, outputIndex: claimIndex };
  }

  // Navigate through inherited space
  let remaining = claimIndex - block.outputs.length;

  // Walk aggregates in reverse order (last aggregate first)
  for (let i = block.aggregates.length - 1; i >= 0; i--) {
    const count = block.aggregateOutputCounts[i];
    if (remaining < count) {
      // Target is in this aggregate's output space at index `remaining`
      return resolveOutputSpaceIndex(block.aggregates[i], remaining, lookup);
    }
    remaining -= count;
  }

  // Remaining maps to surviving anchor outputs (post-subtree-claims).
  // Map through the aggregate subtree mask to get the original anchor
  // output space index before delegating to the anchor.
  const aggMask = _aggregateClaimMask(block, lookup);
  const anchorSpaceIdx = mapSurvivingToOriginal(remaining, aggMask);
  return resolveOutputSpaceIndex(block.anchor, anchorSpaceIdx, lookup);
}

/**
 * Resolve an index in block's output space (post-claims) to the producing block.
 *
 * Maps through claim gaps to get the extended vector index, then delegates
 * to resolveClaimIndex.
 */
export function resolveOutputSpaceIndex(
  blockHash: Hash,
  spaceIndex: number,
  lookup: OutputSpaceLookup,
): ResolvedOutput | undefined {
  const block = lookup(blockHash);
  if (!block) return undefined;

  const extIdx = mapSurvivingToOriginal(spaceIndex, block.claims);
  return resolveClaimIndex(blockHash, extIdx, lookup);
}

// -- Inverse: Compute Claim Index ---------------------------------

/**
 * Compute the claim index in block's extended vector for a known output.
 * Inverse of resolveClaimIndex.
 *
 * Returns undefined if the target is not reachable from block's extended vector.
 */
export function computeClaimIndex(
  blockHash: Hash,
  target: ResolvedOutput,
  lookup: OutputSpaceLookup,
): number | undefined {
  const block = lookup(blockHash);
  if (!block) return undefined;

  // Direct match: target is one of block's own outputs
  if (Hash.equals(target.block, blockHash)) {
    if (target.outputIndex < block.outputs.length) {
      return target.outputIndex;
    }
    return undefined;
  }

  // Check each aggregate's subtree. Only match if the target is in the
  // aggregate's NEW outputs (first aggregateOutputCounts[i] entries of its
  // output space), not inherited outputs from the anchor.
  let offset = block.outputs.length;
  for (let i = block.aggregates.length - 1; i >= 0; i--) {
    const spaceIdx = computeOutputSpaceIndex(block.aggregates[i], target, lookup);
    if (spaceIdx !== undefined && spaceIdx < block.aggregateOutputCounts[i]) {
      return offset + spaceIdx;
    }
    offset += block.aggregateOutputCounts[i];
  }

  // Check anchor's subtree. The anchor portion of the extended vector uses
  // surviving anchor indices (post-subtree-claims), so map through the mask.
  const anchorSpaceIdx = computeOutputSpaceIndex(block.anchor, target, lookup);
  if (anchorSpaceIdx !== undefined) {
    const aggMask = _aggregateClaimMask(block, lookup);
    const survivingIdx = mapOriginalToSurviving(anchorSpaceIdx, aggMask);
    if (survivingIdx === -1) return undefined; // claimed by aggregate subtree
    return offset + survivingIdx;
  }

  return undefined;
}

/**
 * Compute the output space index for a known output in a block.
 * Inverse of resolveOutputSpaceIndex.
 *
 * Returns undefined if the target is not reachable or was claimed.
 */
export function computeOutputSpaceIndex(
  blockHash: Hash,
  target: ResolvedOutput,
  lookup: OutputSpaceLookup,
): number | undefined {
  const extIdx = computeClaimIndex(blockHash, target, lookup);
  if (extIdx === undefined) return undefined;

  const block = lookup(blockHash);
  if (!block) return undefined;

  const result = mapOriginalToSurviving(extIdx, block.claims);
  return result === -1 ? undefined : result;
}

// -- Internal Helpers ---------------------------------------------

/**
 * Compute the combined claim mask that aggregate subtrees make against
 * the block's anchor's output space (excluding the block's own claims).
 *
 * Walks each aggregate's subtree ordering, resolves every non-self claim,
 * and checks if the resolved output lives in the anchor's output space.
 * This correctly handles aggregates that anchor to intermediate blocks
 * (not directly to the aggregator's anchor).
 */
function _aggregateClaimMask(
  block: OutputSpaceBlock,
  lookup: OutputSpaceLookup,
): number[] {
  if (block.aggregates.length === 0) return [];

  const anchorHash = block.anchor;
  const mask: number[] = [];

  for (const aggHash of block.aggregates) {
    const sub = subtreeFrom(aggHash, anchorHash, lookup);
    for (const bHash of sub) {
      const b = lookup(bHash);
      if (!b) continue;
      for (const claimIdx of b.claims) {
        if (claimIdx < b.outputs.length) continue; // self-claim
        const resolved = resolveClaimIndex(bHash, claimIdx, lookup);
        if (!resolved) continue;
        // Check if this resolved output is in the anchor's output space
        const anchorIdx = computeOutputSpaceIndex(anchorHash, resolved, lookup);
        if (anchorIdx !== undefined) {
          mask.push(anchorIdx);
        }
      }
    }
  }

  mask.sort((a, b) => a - b);
  // Deduplicate
  const deduped: number[] = [];
  for (const v of mask) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== v) {
      deduped.push(v);
    }
  }
  return deduped;
}

// -- Claim Masks --------------------------------------------------

/**
 * Compute the claim mask for a block's subtree against its anchor's output space.
 * Returns a sorted array of anchor output indices that the subtree claims.
 *
 * Self-claims are excluded (they don't consume anchor outputs).
 *
 * For leaf blocks: non-self claims mapped directly to anchor indices.
 * For aggregation blocks: union of aggregate masks + own anchor claims.
 */
export function subtreeClaimMask(
  blockHash: Hash,
  lookup: OutputSpaceLookup,
): ClaimMask | undefined {
  const block = lookup(blockHash);
  if (!block) return undefined;

  // Get the aggregate claim mask (claims against our anchor from aggregate subtrees)
  const aggMask = _aggregateClaimMask(block, lookup);

  // Own claims against inherited space
  const ownOutputCount = block.outputs.length;
  const totalAggOutputs = block.aggregateOutputCounts.reduce((a, b) => a + b, 0);
  const inheritedOffset = ownOutputCount + totalAggOutputs;

  const ownAnchorClaims: number[] = [];
  for (const idx of block.claims) {
    if (idx < ownOutputCount) continue; // self-claim
    if (idx < inheritedOffset) continue; // claim on aggregate output

    // This claim hits the surviving anchor space at position (idx - inheritedOffset)
    const survivingIdx = idx - inheritedOffset;
    // Map surviving anchor index back to original anchor index through subtree mask
    const originalIdx = mapSurvivingToOriginal(survivingIdx, aggMask);
    ownAnchorClaims.push(originalIdx);
  }

  ownAnchorClaims.sort((a, b) => a - b);
  return unionClaimMasks(aggMask, ownAnchorClaims);
}

// -- Output Space Computation -------------------------------------

/**
 * Compute the extended vector of a block (before claims are applied).
 * Returns UtxoEntry[] with provenance.
 *
 * Layout: [own outputs, agg[n-1].new, ..., agg[0].new, anchor.surviving]
 */
export function extendedVector(
  blockHash: Hash,
  lookup: OutputSpaceLookup,
): UtxoEntry[] | undefined {
  const block = lookup(blockHash);
  if (!block) return undefined;

  const entries: UtxoEntry[] = [];
  let idx = 0;

  // Own outputs
  for (let i = 0; i < block.outputs.length; i++) {
    entries.push({ block: blockHash, outputIndex: i, spaceIndex: idx++ });
  }

  // Aggregate new outputs (reverse order)
  for (let i = block.aggregates.length - 1; i >= 0; i--) {
    const aggSpace = outputSpace(block.aggregates[i], lookup);
    if (!aggSpace) return undefined;

    // Take only the "new" outputs (first aggregateOutputCounts[i] entries).
    // Use the aggregating block's cached count, not the aggregate's own newOutputCount,
    // because for deep subtrees the cached count covers the entire subtree.
    const newCount = block.aggregateOutputCounts[i];

    for (let j = 0; j < newCount && j < aggSpace.length; j++) {
      entries.push({
        block: aggSpace[j].block,
        outputIndex: aggSpace[j].outputIndex,
        spaceIndex: idx++,
      });
    }
  }

  // Anchor's surviving outputs (after subtree claims)
  if (!Hash.equals(block.anchor, ZERO_HASH)) {
    const anchorSpace = outputSpace(block.anchor, lookup);
    if (!anchorSpace) return undefined;

    // Remove entries claimed by aggregate subtrees (against this block's anchor)
    const aggMask = _aggregateClaimMask(block, lookup);
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
 * Returns UtxoEntry[] with provenance, indexed by output space position.
 *
 * Layout: [surviving own, agg[n-1].new, ..., agg[0].new, anchor.surviving]
 */
export function outputSpace(
  blockHash: Hash,
  lookup: OutputSpaceLookup,
): UtxoEntry[] | undefined {
  const extended = extendedVector(blockHash, lookup);
  if (!extended) return undefined;

  const block = lookup(blockHash);
  if (!block) return undefined;

  // Remove claimed entries
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
