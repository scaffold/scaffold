// Protocol spec: docs/protocol/consensus.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';

/** Configuration for the consensus module. */
export interface ConsensusConfig {
  /**
   * External effective-weight oracle. When supplied, ConsensusModule defers
   * `getEffectiveWeight` (and the conflict-resolution score it backs) to this
   * callback instead of running its own recursive descendant sum. The
   * canonical wiring (`ConsensusService`) routes this through
   * `NodeWeightsService` so blocks and drafts share one propagation model
   * (see docs/protocol/weight-propagation.md).
   *
   * When absent, the legacy recursive `verified_weight + sum(children)`
   * computation is used. This fallback exists so unit tests of
   * `ConsensusModule` can stand up without the surrounding wiring; production
   * paths always supply the callback.
   */
  effectiveWeight?: (hash: Hash) => number;
}

/** Provider interface for the consensus module to access block data. */
export interface ConsensusProvider<BlockType> {
  /** Return the block object for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the hash of a block. */
  getHash(block: BlockType): Hash;

  /** Return the anchor hash (parent in the anchor chain). ZERO_HASH for genesis. */
  getAnchor(block: BlockType): Hash;

  /** Return the hashes of blocks this block aggregates (replaces), or empty array. */
  getAggregates(block: BlockType): Hash[];

  /** Return the declared weight vector for this block. */
  getWeightVector(block: BlockType): number[];
}

/**
 * The consensus module chooses between conflicting branches in the block graph.
 *
 * Canonicality is determined by a three-rule system propagated via topological
 * sort (Kahn's algorithm) over anchor and aggregation edges:
 *
 *   Rule 1 -- Anchor: a non-genesis block is canonical only if its anchor is canonical.
 *   Rule 2 -- Aggregates: a block is canonical only if every block it aggregates is canonical.
 *   Rule 3 -- Conflict: a block is canonical only if it wins (or ties by lower hash) every
 *             direct conflict, compared by effective weight.
 *
 * Effective weight is canonical-independent (includes all descendants) so conflict
 * outcomes are determined once in Phase 1, then propagated structurally in Phase 2.
 *
 * Fully self-contained -- depends only on ConsensusProvider and Hash.
 */
export class ConsensusModule<BlockType> {
  private readonly provider: ConsensusProvider<BlockType>;
  private readonly externalEffectiveWeight: ((hash: Hash) => number) | undefined;

  /** All registered block hashes, keyed by hash primitive. */
  private blocks = new Map<HashPrimitive, Hash>();

  /** Direct conflicts declared by external layers. Stored symmetrically. */
  private directConflicts = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Reverse: block -> set of blocks that aggregate it. */
  private aggregatedByMap = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Verified weight vectors per block. Defaults to empty (zero weight). */
  private verifiedWeights = new Map<HashPrimitive, number[]>();

  /** Per-block boost applied only during conflict comparison (not propagated). */
  private boosts = new Map<HashPrimitive, number>();

  /** Anchor -> set of blocks that directly anchor to it. */
  private children = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Cached canonical view. Null means dirty. */
  private canonicalCache: Set<HashPrimitive> | null = null;

  /** Previous canonical snapshot for change detection. */
  private previousCanonical: Set<HashPrimitive> | null = null;

  /** Listeners for canonicality changes. */
  private canonicalityListeners: ((hash: Hash, canonical: boolean) => void)[] = [];

  constructor(provider: ConsensusProvider<BlockType>, config?: ConsensusConfig) {
    this.provider = provider;
    this.externalEffectiveWeight = config?.effectiveWeight;
  }

  /** Register a listener for canonicality changes. Returns an unsubscribe function. */
  onCanonicalityChange(cb: (hash: Hash, canonical: boolean) => void): () => void {
    this.canonicalityListeners.push(cb);
    return () => {
      const i = this.canonicalityListeners.indexOf(cb);
      if (i >= 0) this.canonicalityListeners.splice(i, 1);
    };
  }

  /**
   * Diff canonical set against previous snapshot, fire listeners for each change.
   * Non-canonical changes fire first (undo old state), then canonical changes
   * (apply new state). This ordering ensures that consumers tracking claimed
   * state see the correct final state after conflict flips.
   */
  flushChanges(): void {
    const current = this.getCanonicalView();
    if (!this.previousCanonical) {
      this.previousCanonical = new Set(current);
      return;
    }
    // Fire non-canonical first: undo old state
    for (const key of this.previousCanonical) {
      if (!current.has(key)) {
        const hash = Hash.fromPrimitive(key);
        for (const cb of this.canonicalityListeners) cb(hash, false);
      }
    }
    // Then fire canonical: apply new state
    for (const key of current) {
      if (!this.previousCanonical.has(key)) {
        const hash = Hash.fromPrimitive(key);
        for (const cb of this.canonicalityListeners) cb(hash, true);
      }
    }
    this.previousCanonical = new Set(current);
  }

  // -- Mutations --------------------------------------------------

  /** Register a block. Automatically registers aggregation relationships. */
  addBlock(hash: Hash): void {
    const key = hash.toPrimitive();
    if (this.blocks.has(key)) return;

    this.blocks.set(key, hash);

    const block = this.provider.getBlock(hash);
    if (!block) return;

    // Register in children map (anchor -> this block)
    const anchorHash = this.provider.getAnchor(block);
    if (!Hash.equals(anchorHash, ZERO_HASH)) {
      const anchorKey = anchorHash.toPrimitive();
      this.getOrCreateSet(this.children, anchorKey).add(key);
    }

    // Register aggregation (reverse map only -- needed for topological sort)
    const aggregates = this.provider.getAggregates(block);
    for (const s of aggregates) {
      const sKey = s.toPrimitive();
      this.getOrCreateSet(this.aggregatedByMap, sKey).add(key);
    }

    this.markDirty();
  }

  /**
   * Remove a previously registered block.
   * Cleans up children, aggregation maps, verified weights, and direct
   * conflicts. Marks dirty.
   */
  removeBlock(hash: Hash): void {
    const key = hash.toPrimitive();
    if (!this.blocks.has(key)) return;

    this.blocks.delete(key);

    // Remove from children map (as child of its anchor)
    const block = this.provider.getBlock(hash);
    if (block) {
      const anchorHash = this.provider.getAnchor(block);
      if (!Hash.equals(anchorHash, ZERO_HASH)) {
        const siblings = this.children.get(anchorHash.toPrimitive());
        if (siblings) siblings.delete(key);
      }

      // Clean up aggregatedByMap (reverse aggregation edges from this block)
      const aggregates = this.provider.getAggregates(block);
      for (const s of aggregates) {
        const sKey = s.toPrimitive();
        const reverse = this.aggregatedByMap.get(sKey);
        if (reverse) reverse.delete(key);
      }
    }

    // Remove own children entry
    this.children.delete(key);

    // Clean up aggregatedByMap entry for this block
    this.aggregatedByMap.delete(key);

    // Clean up verified weights and boosts
    this.verifiedWeights.delete(key);
    this.boosts.delete(key);

    // Clean up direct conflicts
    const conflicts = this.directConflicts.get(key);
    if (conflicts) {
      for (const cKey of conflicts) {
        const reverse = this.directConflicts.get(cKey);
        if (reverse) reverse.delete(key);
      }
      this.directConflicts.delete(key);
    }

    this.markDirty();
  }

  /** Declare a direct conflict between two blocks (symmetric). */
  addConflict(a: Hash, b: Hash): void {
    const aKey = a.toPrimitive();
    const bKey = b.toPrimitive();
    this.getOrCreateSet(this.directConflicts, aKey).add(bKey);
    this.getOrCreateSet(this.directConflicts, bKey).add(aKey);
    this.markDirty();
  }

  /** Remove a previously declared direct conflict. */
  removeConflict(a: Hash, b: Hash): void {
    const aKey = a.toPrimitive();
    const bKey = b.toPrimitive();
    this.directConflicts.get(aKey)?.delete(bKey);
    this.directConflicts.get(bKey)?.delete(aKey);
    this.markDirty();
  }

  /** Set the verified weight vector for a block. */
  setVerifiedWeight(hash: Hash, weight: number[]): void {
    this.verifiedWeights.set(hash.toPrimitive(), weight);
    this.markDirty();
  }

  /** Set a conflict-resolution boost for a block. Does not propagate to ancestors. */
  setBoost(hash: Hash, boost: number): void {
    this.boosts.set(hash.toPrimitive(), boost);
    this.markDirty();
  }

  // -- Queries ----------------------------------------------------

  /**
   * Effective weight for conflict resolution. Defers to the configured
   * `effectiveWeight` callback (production wiring routes through
   * `NodeWeightsService`) when present; otherwise runs the legacy recursive
   * descendant sum.
   */
  getEffectiveWeight(hash: Hash): number {
    if (this.externalEffectiveWeight) return this.externalEffectiveWeight(hash);
    const memo = new Map<HashPrimitive, number>();
    return this.computeEffectiveWeight(hash.toPrimitive(), memo);
  }

  /** Whether a block is in the current canonical view. */
  isCanonical(hash: Hash): boolean {
    this.ensureCanonical();
    return this.canonicalCache!.has(hash.toPrimitive());
  }

  /** The full canonical view as a set of hash primitives. */
  getCanonicalView(): ReadonlySet<HashPrimitive> {
    this.ensureCanonical();
    return this.canonicalCache!;
  }

  /**
   * Direct conflict set for a block. Returns only explicitly declared
   * direct conflicts (no transitive expansion). Excludes the block itself.
   */
  getConflicts(hash: Hash): ReadonlySet<HashPrimitive> {
    const key = hash.toPrimitive();
    const dc = this.directConflicts.get(key);
    return dc ?? new Set<HashPrimitive>();
  }

  /**
   * The winner among a block and all blocks it directly conflicts with.
   * Returns the block itself if it has no conflicts or is the winner.
   */
  getConflictWinner(hash: Hash): Hash {
    const key = hash.toPrimitive();
    const conflicts = this.directConflicts.get(key);
    if (!conflicts || conflicts.size === 0) return hash;

    const memo = new Map<HashPrimitive, number>();
    const score = (k: HashPrimitive, h: Hash): number =>
      (this.externalEffectiveWeight
        ? this.externalEffectiveWeight(h)
        : this.computeEffectiveWeight(k, memo)) +
      (this.boosts.get(k) ?? 0);

    let bestHash = hash;
    let bestWeight = score(key, hash);

    for (const cKey of conflicts) {
      const cHash = this.blocks.get(cKey);
      if (!cHash) continue;
      const cWeight = score(cKey, cHash);
      if (
        cWeight > bestWeight ||
        (cWeight === bestWeight && Hash.compare(cHash, bestHash) < 0)
      ) {
        bestHash = cHash;
        bestWeight = cWeight;
      }
    }

    return bestHash;
  }

  // -- Internals --------------------------------------------------

  private markDirty(): void {
    this.canonicalCache = null;
  }

  private getOrCreateSet(
    map: Map<HashPrimitive, Set<HashPrimitive>>,
    key: HashPrimitive,
  ): Set<HashPrimitive> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }

  /**
   * Legacy fallback effective weight (used only when no `effectiveWeight`
   * callback is supplied -- typically `ConsensusModule` unit tests).
   *
   * effective_weight(B) = sum(verified_weight) + sum(effective_weight(child))
   *   for each child that anchors to B.
   *
   * Production code goes through `NodeWeightsService` via the configured
   * callback; see docs/protocol/weight-propagation.md for the model.
   */
  private computeEffectiveWeight(
    blockKey: HashPrimitive,
    memo: Map<HashPrimitive, number>,
  ): number {
    const cached = memo.get(blockKey);
    if (cached !== undefined) return cached;

    // Guard against cycles (shouldn't happen in DAG, but safety)
    memo.set(blockKey, 0);

    // Own verified weight
    const vw = this.verifiedWeights.get(blockKey);
    let ownWeight = 0;
    if (vw) {
      for (const w of vw) ownWeight += w;
    }

    let descWeight = 0;
    const kids = this.children.get(blockKey);
    if (kids) {
      for (const childKey of kids) {
        descWeight += this.computeEffectiveWeight(childKey, memo);
      }
    }

    const total = ownWeight + descWeight;
    memo.set(blockKey, total);
    return total;
  }

  /** Compute the canonical view using the two-phase topological algorithm. */
  private ensureCanonical(): void {
    if (this.canonicalCache !== null) return;
    this.canonicalCache = this.computeCanonicalPass();
  }

  /**
   * Single pass of conflict resolution + topological propagation.
   *
   * Phase 1: Determine direct conflict outcomes. For each block with
   *   direct conflicts, compare effective weights (ties broken by lower hash)
   *   to record winners and losers.
   *
   * Phase 2: Propagate canonicality via Kahn's algorithm over anchor and
   *   aggregation edges. A block enters the canonical set only if:
   *     Rule 1 -- its anchor is canonical (or it is genesis)
   *     Rule 2 -- every aggregate it references is canonical
   *     Rule 3 -- it won its direct conflict (or has none)
   */
  private computeCanonicalPass(): Set<HashPrimitive> {
    const canonical = new Set<HashPrimitive>();
    const memo = new Map<HashPrimitive, number>();

    // -- Phase 1: Determine direct conflict outcomes --

    // A block is a loser if ANY direct conflict partner beats it.
    // Evaluated pairwise: A ⚡ B and B ⚡ C does not mean A ⚡ C.
    const conflictLosers = new Set<HashPrimitive>();

    const score = (k: HashPrimitive, h: Hash): number =>
      (this.externalEffectiveWeight
        ? this.externalEffectiveWeight(h)
        : this.computeEffectiveWeight(k, memo)) +
      (this.boosts.get(k) ?? 0);

    for (const blockKey of this.blocks.keys()) {
      const dc = this.directConflicts.get(blockKey);
      if (!dc || dc.size === 0) continue;

      const blockHash = this.blocks.get(blockKey)!;
      const blockWeight = score(blockKey, blockHash);

      for (const partnerKey of dc) {
        if (!this.blocks.has(partnerKey)) continue;
        const partnerHash = this.blocks.get(partnerKey)!;
        const partnerWeight = score(partnerKey, partnerHash);

        if (
          partnerWeight > blockWeight ||
          (partnerWeight === blockWeight &&
            Hash.compare(partnerHash, blockHash) < 0)
        ) {
          conflictLosers.add(blockKey);
          break;
        }
      }
    }

    // -- Phase 2: Kahn's algorithm over anchor + aggregation edges --

    // Compute in-degree for each block:
    //   +1 if has a non-ZERO_HASH anchor that is in our blocks map
    //   +1 for each aggregate that is in our blocks map
    const inDegree = new Map<HashPrimitive, number>();
    for (const blockKey of this.blocks.keys()) {
      let deg = 0;
      const hash = this.blocks.get(blockKey)!;
      const block = this.provider.getBlock(hash);
      if (block) {
        const anchor = this.provider.getAnchor(block);
        if (!Hash.equals(anchor, ZERO_HASH) && this.blocks.has(anchor.toPrimitive())) {
          deg++;
        }
        const aggregates = this.provider.getAggregates(block);
        for (const agg of aggregates) {
          if (this.blocks.has(agg.toPrimitive())) {
            deg++;
          }
        }
      }
      inDegree.set(blockKey, deg);
    }

    // Initialize queue with all in-degree-0 blocks (genesis blocks)
    const queue: HashPrimitive[] = [];
    for (const [blockKey, deg] of inDegree) {
      if (deg === 0) queue.push(blockKey);
    }

    while (queue.length > 0) {
      const blockKey = queue.shift()!;
      const hash = this.blocks.get(blockKey);
      if (!hash) continue;

      const block = this.provider.getBlock(hash);

      // Rule 1: anchor must be canonical (unless genesis)
      if (block) {
        const anchor = this.provider.getAnchor(block);
        if (!Hash.equals(anchor, ZERO_HASH) && this.blocks.has(anchor.toPrimitive())) {
          if (!canonical.has(anchor.toPrimitive())) {
            // Anchor is not canonical -- skip this block (don't add to canonical)
            this.decrementSuccessors(blockKey, inDegree, queue);
            continue;
          }
        }
      }

      // Rule 2: all aggregates must be canonical
      if (block) {
        const aggregates = this.provider.getAggregates(block);
        let allAggregatesCanonical = true;
        for (const agg of aggregates) {
          if (this.blocks.has(agg.toPrimitive()) && !canonical.has(agg.toPrimitive())) {
            allAggregatesCanonical = false;
            break;
          }
        }
        if (!allAggregatesCanonical) {
          this.decrementSuccessors(blockKey, inDegree, queue);
          continue;
        }
      }

      // Rule 3: must not have lost its direct conflict
      if (conflictLosers.has(blockKey)) {
        this.decrementSuccessors(blockKey, inDegree, queue);
        continue;
      }

      // All rules pass -- block is canonical
      canonical.add(blockKey);
      this.decrementSuccessors(blockKey, inDegree, queue);
    }

    return canonical;
  }

  /**
   * Decrement in-degree of all successors (children and aggregatedBy) of
   * a block, enqueueing any that reach zero.
   */
  private decrementSuccessors(
    blockKey: HashPrimitive,
    inDegree: Map<HashPrimitive, number>,
    queue: HashPrimitive[],
  ): void {
    // Children: blocks that anchor to this one
    const kids = this.children.get(blockKey);
    if (kids) {
      for (const childKey of kids) {
        const deg = (inDegree.get(childKey) ?? 0) - 1;
        inDegree.set(childKey, deg);
        if (deg === 0) queue.push(childKey);
      }
    }

    // AggregatedBy: blocks that list this one in their aggregates
    const aggBy = this.aggregatedByMap.get(blockKey);
    if (aggBy) {
      for (const abKey of aggBy) {
        const deg = (inDegree.get(abKey) ?? 0) - 1;
        inDegree.set(abKey, deg);
        if (deg === 0) queue.push(abKey);
      }
    }
  }
}
