// Protocol spec: docs/protocol/placement.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { Node } from './Node.ts';

// -- Provider -----------------------------------------------------

/**
 * Provider interface for placement. Reads the block graph plus the
 * canonical-aggregator relationship maintained by the consensus layer.
 */
export interface PlacementProvider<BlockType> {
  /** Return the block object for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the anchor hash. ZERO_HASH for genesis. */
  getAnchor(block: BlockType): Hash;

  /** Return the block's direct aggregates. */
  getAggregates(block: BlockType): Hash[];

  /**
   * Return the unique canonical block whose `aggregates` field directly
   * contains `hash`, or undefined if none.
   *
   * Aggregator-uniqueness is a consensus invariant: two aggregators that
   * share an aggregate conflict, so at most one canonical aggregator
   * exists for any given block.
   */
  getCanonicalAggregator(hash: Hash): Hash | undefined;
}

// -- Result -------------------------------------------------------

export type PlacementResult =
  | { ok: true; anchor: Hash }
  | { ok: false; stalled: true };

// -- Module -------------------------------------------------------

/**
 * Placement: choose an anchor for a block being solidified.
 *
 * Inputs:
 *  - claimedBlocks: producers of the draft's claims (deduped)
 *  - aggregatedBlocks: blocks the draft will roll up via its `aggregates` field
 *  - excludedBlocks: blocks that must not appear in the chosen anchor's
 *    anchor chain or in any of its canonical-aggregator subtrees
 *
 * Returns the anchor hash, or a stalled signal indicating no anchor exists
 * under the current canonical view (caller retries on canonical changes).
 *
 * See docs/protocol/placement.md for the algorithm specification.
 */
export class PlacementModule<BlockType> {
  private readonly provider: PlacementProvider<BlockType>;

  constructor(provider: PlacementProvider<BlockType>) {
    this.provider = provider;
  }

  // -- Public API -------------------------------------------------

  place(request: {
    /**
     * The Node (typically a Draft) being placed. Carried through so the
     * service-layer adapter can scope per-call state -- e.g. excluding
     * the in-progress draft from any canonical-view lookups it needs to
     * make, breaking the otherwise cyclic dependency between placement
     * and consensus-weight computation. The pure module ignores it.
     */
    node?: Node;
    claimedBlocks: Hash[];
    aggregatedBlocks: Hash[];
    excludedBlocks: Hash[];
  }): PlacementResult {
    const { claimedBlocks, aggregatedBlocks, excludedBlocks } = request;

    // -- Pre-processing Pass 1: aggregated blocks become claim-like includes
    const aggregatedSet = new Set(aggregatedBlocks.map((h) => h.toPrimitive()));
    const outsideAnchors: Hash[] = [];
    for (const D of aggregatedBlocks) {
      const outside = this.outsideAnchor(D, aggregatedSet);
      if (!outside) {
        // D's anchor chain didn't escape the aggregatedSet before genesis,
        // or a block on the walk is missing from the store. Either is a
        // structural problem the caller can't recover from at placement time.
        return { ok: false, stalled: true };
      }
      outsideAnchors.push(outside);
    }

    // -- Pre-processing Pass 2: drop subsumed claims
    const remainingClaims: Hash[] = [];
    for (const X of claimedBlocks) {
      if (!this.aggregationChainHits(X, aggregatedSet)) {
        remainingClaims.push(X);
      }
    }

    // Build the include set (deduped union of outside anchors and surviving claims)
    const includeSet = new Map<HashPrimitive, Hash>();
    for (const h of [...remainingClaims, ...outsideAnchors]) {
      includeSet.set(h.toPrimitive(), h);
    }
    const includeBlocks = [...includeSet.values()];

    if (includeBlocks.length === 0) {
      // Nothing to anchor against: caller's contract requires at least
      // one claim or aggregated block. Treat as stalled rather than
      // throwing -- it's harmless to retry.
      return { ok: false, stalled: true };
    }

    // -- Build aggregation chains for include and exclude blocks
    const includeChains = includeBlocks.map((B) => this.aggregationChain(B));
    const excludeChains = excludedBlocks.map((E) => this.aggregationChain(E));

    // Pre-compute include and exclude chains as sets for O(1) intersection checks
    const includeChainSets = includeChains.map((c) => new Set(c.map((h) => h.toPrimitive())));
    const excludeChainSets = excludeChains.map((c) => new Set(c.map((h) => h.toPrimitive())));

    // -- Main loop: for each include chain, select the first qualifying item
    const selections = new Map<HashPrimitive, Hash>();
    for (const Ci of includeChains) {
      const K = this.firstQualifying(Ci, includeChainSets, excludeChainSets);
      if (K) selections.set(K.toPrimitive(), K);
    }

    if (selections.size === 0) {
      return { ok: false, stalled: true };
    }
    if (selections.size > 1) {
      // Invariant violation: with canonical-aggregator uniqueness, every
      // chain that selects a non-null item should converge on the same
      // block. See placement.md for the argument.
      const hexes = [...selections.values()].map((h) => h.toHex().slice(0, 8));
      throw new Error(
        `placement invariant: |S| > 1 (selections: ${hexes.join(', ')})`,
      );
    }

    const [anchor] = [...selections.values()];
    return { ok: true, anchor };
  }

  // -- Helpers ----------------------------------------------------

  /**
   * Walk D's anchor chain toward genesis, returning the first block whose
   * aggregation chain does not intersect `aggregatedSet` (sibling or self).
   *
   * Stronger than the naive "first block not in aggregatedSet" rule: a
   * candidate whose canonical aggregator is in the set would route the
   * eventual placement through that aggregator, which we are itself
   * aggregating -- letting it through would let placement pick a deeper
   * anchor that violates aggregation.md's rooted-at-anchor invariant.
   *
   * Returns undefined if the walk reaches genesis without finding such
   * a block, or if a block on the walk is missing.
   */
  private outsideAnchor(
    D: Hash,
    aggregatedSet: Set<HashPrimitive>,
  ): Hash | undefined {
    let cur = D;
    const seen = new Set<HashPrimitive>();
    while (true) {
      const key = cur.toPrimitive();
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (!this.aggregationChainHits(cur, aggregatedSet)) {
        return cur;
      }
      const block = this.provider.getBlock(cur);
      if (!block) return undefined;
      const anchor = this.provider.getAnchor(block);
      if (Hash.equals(anchor, ZERO_HASH)) return undefined;
      cur = anchor;
    }
  }

  /**
   * Test whether X's aggregation chain intersects `aggregatedSet`. Used
   * by Pass 2 to drop subsumed claims.
   */
  private aggregationChainHits(
    X: Hash,
    aggregatedSet: Set<HashPrimitive>,
  ): boolean {
    let cur: Hash | undefined = X;
    const seen = new Set<HashPrimitive>();
    while (cur) {
      const key = cur.toPrimitive();
      if (seen.has(key)) return false;
      seen.add(key);
      if (aggregatedSet.has(key)) return true;
      cur = this.provider.getCanonicalAggregator(cur);
    }
    return false;
  }

  /**
   * Recursive walk along canonical-aggregator links, starting with X.
   * Terminates at the first block with no canonical aggregator.
   */
  private aggregationChain(X: Hash): Hash[] {
    const chain: Hash[] = [];
    const seen = new Set<HashPrimitive>();
    let cur: Hash | undefined = X;
    while (cur) {
      const key = cur.toPrimitive();
      if (seen.has(key)) break;
      seen.add(key);
      chain.push(cur);
      cur = this.provider.getCanonicalAggregator(cur);
    }
    return chain;
  }

  /**
   * Recursive walk along anchor links, starting with A. Terminates at
   * genesis. Stops if a block on the walk is missing from the store.
   */
  private anchorChain(A: Hash): Hash[] {
    const chain: Hash[] = [];
    const seen = new Set<HashPrimitive>();
    let cur = A;
    while (!Hash.equals(cur, ZERO_HASH)) {
      const key = cur.toPrimitive();
      if (seen.has(key)) break;
      seen.add(key);
      chain.push(cur);
      const block = this.provider.getBlock(cur);
      if (!block) break;
      cur = this.provider.getAnchor(block);
    }
    return chain;
  }

  /**
   * Scan items in `chain` order; return the first whose anchor chain
   * intersects every set in `includeChainSets` and intersects no set in
   * `excludeChainSets`.
   */
  private firstQualifying(
    chain: Hash[],
    includeChainSets: Set<HashPrimitive>[],
    excludeChainSets: Set<HashPrimitive>[],
  ): Hash | undefined {
    for (const K of chain) {
      const anchorChain = this.anchorChain(K);
      const anchorSet = new Set(anchorChain.map((h) => h.toPrimitive()));

      let coversIncludes = true;
      for (const inc of includeChainSets) {
        if (!setsIntersect(anchorSet, inc)) {
          coversIncludes = false;
          break;
        }
      }
      if (!coversIncludes) continue;

      let hitsExcludes = false;
      for (const exc of excludeChainSets) {
        if (setsIntersect(anchorSet, exc)) {
          hitsExcludes = true;
          break;
        }
      }
      if (hitsExcludes) continue;

      return K;
    }
    return undefined;
  }
}

// -- Local utilities ----------------------------------------------

function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  // Iterate the smaller set for cheaper lookups.
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of smaller) {
    if (larger.has(v)) return true;
  }
  return false;
}
