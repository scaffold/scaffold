import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';

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
 * It tracks blocks, conflicts, and verified weights, and computes the canonical
 * view: the maximal set of non-conflicting blocks where each conflict's winner
 * (by effective weight, ties broken by hash) is included.
 *
 * Fully self-contained -- depends only on ConsensusProvider and Hash.
 */
export class ConsensusModule<BlockType> {
  private readonly provider: ConsensusProvider<BlockType>;

  /** All registered block hashes, keyed by hash primitive. */
  private blocks = new Map<HashPrimitive, Hash>();

  /** Direct conflicts declared by external layers. Stored symmetrically. */
  private directConflicts = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Block -> set of block hash primitives it aggregates. */
  private aggregatesMap = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Reverse: block -> set of blocks that aggregate it. */
  private aggregatedByMap = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Verified weight vectors per block. Defaults to empty (zero weight). */
  private verifiedWeights = new Map<HashPrimitive, number[]>();

  /** Anchor -> set of blocks that directly anchor to it. */
  private children = new Map<HashPrimitive, Set<HashPrimitive>>();

  /**
   * For weight-vector-aware descendant weight: maps each chain block to
   * the list of (block, depth) pairs that contribute weight to it.
   */
  private chainContributions = new Map<
    HashPrimitive,
    { block: HashPrimitive; depth: number }[]
  >();

  /** Cached canonical view. Null means dirty. */
  private canonicalCache: Set<HashPrimitive> | null = null;

  constructor(provider: ConsensusProvider<BlockType>) {
    this.provider = provider;
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

    // Register aggregation
    const aggregates = this.provider.getAggregates(block);
    if (aggregates.length > 0) {
      const sSet = new Set<HashPrimitive>();
      for (const s of aggregates) {
        const sKey = s.toPrimitive();
        sSet.add(sKey);
        this.getOrCreateSet(this.aggregatedByMap, sKey).add(key);
      }
      this.aggregatesMap.set(key, sSet);
    }

    // Register chain contributions for weight-vector-aware descendant weight
    let current = anchorHash;
    let depth = 0;
    while (!Hash.equals(current, ZERO_HASH)) {
      const cKey = current.toPrimitive();
      if (!this.chainContributions.has(cKey)) {
        this.chainContributions.set(cKey, []);
      }
      this.chainContributions.get(cKey)!.push({ block: key, depth });

      const cBlock = this.provider.getBlock(current);
      if (!cBlock) break;
      current = this.provider.getAnchor(cBlock);
      depth++;
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

  // -- Queries ----------------------------------------------------

  /** Effective weight: own verified weight + descendant weight (recursive). */
  getEffectiveWeight(hash: Hash): number {
    const memo = new Map<HashPrimitive, number>();
    return this.computeEffectiveWeight(hash.toPrimitive(), memo);
  }

  /**
   * Weight-vector-aware descendant weight for a chain block.
   * Sums verified_weight[i] for each canonical block that has `hash` at
   * depth i in its anchor chain.
   */
  getDescendantWeight(hash: Hash): number {
    this.ensureCanonical();
    const key = hash.toPrimitive();
    const contributions = this.chainContributions.get(key);
    if (!contributions) return 0;

    let total = 0;
    for (const { block, depth } of contributions) {
      if (!this.canonicalCache!.has(block)) continue;
      const vw = this.verifiedWeights.get(block);
      if (vw && depth < vw.length) {
        total += vw[depth];
      }
    }
    return total;
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
   * Full conflict set for a block: direct + aggregation + inherited +
   * propagated via anchor chains. Excludes the block itself.
   */
  getConflicts(hash: Hash): ReadonlySet<HashPrimitive> {
    return this.computeFullConflicts(hash.toPrimitive());
  }

  /**
   * The winner among a block and all blocks it conflicts with.
   * Returns the block itself if it has no conflicts or is the winner.
   */
  getConflictWinner(hash: Hash): Hash {
    const key = hash.toPrimitive();
    const conflicts = this.computeFullConflicts(key);
    if (conflicts.size === 0) return hash;

    const memo = new Map<HashPrimitive, number>();

    let bestHash = hash;
    let bestWeight = this.computeEffectiveWeight(key, memo);

    for (const cKey of conflicts) {
      const cHash = this.blocks.get(cKey);
      if (!cHash) continue;
      const cWeight = this.computeEffectiveWeight(cKey, memo);
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

  /** Look up a block's anchor hash primitive, or undefined for genesis. */
  private getAnchorKeyOf(blockKey: HashPrimitive): HashPrimitive | undefined {
    const hash = this.blocks.get(blockKey);
    if (!hash) return undefined;
    const block = this.provider.getBlock(hash);
    if (!block) return undefined;
    const anchor = this.provider.getAnchor(block);
    if (Hash.equals(anchor, ZERO_HASH)) return undefined;
    return anchor.toPrimitive();
  }

  /**
   * Compute the full conflict set for a block.
   *
   * Phase 1 (base): Walk the anchor chain to build the lineage. For each
   *   block in the lineage, BFS through the aggregation graph collecting
   *   direct + aggregation conflicts + reverse aggregation.
   *
   * Phase 2 (propagation): BFS forward along anchor children. If X
   *   conflicts with Y, then X also conflicts with every descendant
   *   of Y via anchor links.
   */
  private computeFullConflicts(blockKey: HashPrimitive): Set<HashPrimitive> {
    const result = new Set<HashPrimitive>();

    // Build anchor chain lineage: [blockKey, anchor, anchor.anchor, ...]
    const lineage: HashPrimitive[] = [];
    let cur: HashPrimitive | undefined = blockKey;
    while (cur !== undefined) {
      lineage.push(cur);
      cur = this.getAnchorKeyOf(cur);
    }

    // Phase 1: For each block in lineage, collect base conflicts
    for (const source of lineage) {
      // BFS through aggregation graph from source
      const visited = new Set<HashPrimitive>();
      const queue: HashPrimitive[] = [source];

      while (queue.length > 0) {
        const current = queue.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);

        // Aggregation conflict: current is aggregated by source's BFS
        if (current !== source) {
          result.add(current);
        }

        // Collect direct conflicts of current
        const dc = this.directConflicts.get(current);
        if (dc) {
          for (const d of dc) {
            result.add(d);
          }
        }

        // Recurse into blocks that current aggregates
        const ss = this.aggregatesMap.get(current);
        if (ss) {
          for (const s of ss) {
            queue.push(s);
          }
        }
      }

      // Reverse aggregation: blocks that aggregate this lineage member
      const sb = this.aggregatedByMap.get(source);
      if (sb) {
        for (const s of sb) {
          result.add(s);
        }
      }
    }

    // Phase 2: propagate forward along anchor children (descendants)
    const propQueue: HashPrimitive[] = [...result];
    while (propQueue.length > 0) {
      const y = propQueue.pop()!;
      const kids = this.children.get(y);
      if (!kids) continue;
      for (const child of kids) {
        if (!result.has(child) && child !== blockKey) {
          result.add(child);
          propQueue.push(child);
        }
      }
    }

    // Remove lineage members and self -- ancestors are not conflicts
    for (const l of lineage) {
      result.delete(l);
    }
    return result;
  }

  /**
   * Compute effective weight of a block. Canonical-independent: includes
   * ALL children (a child contributes to its parent's weight regardless
   * of whether the child wins its own conflicts).
   *
   * effective_weight(B) = sum(verified_weight) + sum(effective_weight(child))
   *   for each child that anchors to B.
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
      for (const w of vw) {
        ownWeight += w;
      }
    }

    // Descendant weight from all children
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

  /**
   * Compute the canonical view in a single pass.
   *
   * Since effective weight is canonical-independent (includes all
   * descendants), weights are stable and we can determine winners
   * without iteration: a block is canonical iff it beats every
   * block in its conflict set.
   */
  private ensureCanonical(): void {
    if (this.canonicalCache !== null) return;

    const canonical = new Set<HashPrimitive>();
    const memo = new Map<HashPrimitive, number>();

    for (const blockKey of this.blocks.keys()) {
      const conflicts = this.computeFullConflicts(blockKey);
      if (conflicts.size === 0) {
        canonical.add(blockKey);
        continue;
      }

      const blockHash = this.blocks.get(blockKey)!;
      const blockWeight = this.computeEffectiveWeight(blockKey, memo);
      let isWinner = true;

      for (const conflictKey of conflicts) {
        if (!this.blocks.has(conflictKey)) continue;
        const conflictHash = this.blocks.get(conflictKey)!;
        const conflictWeight = this.computeEffectiveWeight(
          conflictKey,
          memo,
        );

        if (
          conflictWeight > blockWeight ||
          (conflictWeight === blockWeight &&
            Hash.compare(conflictHash, blockHash) < 0)
        ) {
          isWinner = false;
          break;
        }
      }

      if (isWinner) {
        canonical.add(blockKey);
      }
    }

    this.canonicalCache = canonical;
  }
}
