import { Hash, HashPrimitive } from './util/Hash.ts';
import { BitVector, RebaseResult } from './BitVector.ts';

/**
 * Provider interface for the conflict module to access block data.
 * The conflict module is fully encapsulated — it knows nothing about
 * block internals beyond what this interface exposes.
 */
export interface ConflictProvider<BlockType> {
  /** Return the block object for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the hash of a block. */
  getHash(block: BlockType): Hash;

  /** Return the anchor hash, or undefined for genesis. */
  getAnchor(block: BlockType): Hash | undefined;

  /**
   * Return the subtree claim mask: a bit vector of length anchorOutputCount
   * indicating which anchor outputs the block's subtrees collectively claim.
   * Returns null if this block has no subtrees (leaf block).
   */
  getClaimMask(block: BlockType): BitVector | null;

  /**
   * Return the number of outputs each subtree contributes.
   * Empty array if this block has no subtrees.
   */
  getAggregateOutputCounts(block: BlockType): number[];

  /**
   * Return the block's own claim mask against the current output vector
   * (after subtree transformations). Bit vector of length = current vector size.
   */
  getOwnClaims(block: BlockType): BitVector;

  /** Return the number of new outputs this block itself produces. */
  getOwnOutputCount(block: BlockType): number;

  /** Return the total output count of this block after all transformations. */
  getOutputCount(block: BlockType): number;

  /** Return the total output count of this block's anchor, or 0 for genesis. */
  getAnchorOutputCount(block: BlockType): number;

  /** Return ordered list of subtree root hashes. Empty if no subtrees. */
  getChildren(block: BlockType): Hash[];
}

/**
 * The conflict module detects double-spend conflicts between blocks.
 *
 * Two blocks conflict if they both claim (spend) the same output from a
 * shared ancestor. Claims are encoded as bit vectors, enabling fast
 * conflict detection via bitwise intersection.
 *
 * This module feeds direct conflict declarations to the consensus module.
 *
 * Fully self-contained — depends only on ConflictProvider, BitVector, and Hash.
 */
export class ConflictModule<BlockType> {
  private readonly provider: ConflictProvider<BlockType>;

  /** All registered block hashes. */
  private blocks = new Map<HashPrimitive, Hash>();

  /** Conflicts stored symmetrically: A->Set{B} and B->Set{A}. */
  private conflicts = new Map<HashPrimitive, Set<HashPrimitive>>();

  /** Anchor -> set of blocks that directly anchor to it. */
  private anchorChildren = new Map<HashPrimitive, Set<HashPrimitive>>();

  /**
   * Cached net claim masks (against anchor's output space).
   * Computed from subtree claimMask + own claims rebased to anchor space.
   */
  private netClaimMasks = new Map<HashPrimitive, BitVector>();

  constructor(provider: ConflictProvider<BlockType>) {
    this.provider = provider;
  }

  // -- Mutations --------------------------------------------------

  /**
   * Register a block. Computes its net claim mask and checks for
   * conflicts with all other blocks sharing the same anchor.
   * Returns any newly discovered conflict pairs.
   */
  addBlock(hash: Hash): [Hash, Hash][] {
    const key = hash.toPrimitive();
    if (this.blocks.has(key)) return [];

    this.blocks.set(key, hash);

    const block = this.provider.getBlock(hash);
    if (!block) return [];

    // Register in anchor children
    const anchorHash = this.provider.getAnchor(block);
    if (anchorHash) {
      const anchorKey = anchorHash.toPrimitive();
      this.getOrCreateSet(this.anchorChildren, anchorKey).add(key);
    }

    // Compute net claim mask
    const netMask = this.computeNetClaimMask(block);
    if (netMask) {
      this.netClaimMasks.set(key, netMask);
    }

    // Check conflicts with siblings (same anchor)
    const newConflicts: [Hash, Hash][] = [];
    if (anchorHash && netMask) {
      const siblings = this.anchorChildren.get(anchorHash.toPrimitive());
      if (siblings) {
        for (const sibKey of siblings) {
          if (sibKey === key) continue;
          const sibMask = this.netClaimMasks.get(sibKey);
          if (sibMask && netMask.intersects(sibMask)) {
            this.addConflict(hash, this.blocks.get(sibKey)!);
            newConflicts.push([hash, this.blocks.get(sibKey)!]);
          }
        }
      }
    }

    return newConflicts;
  }

  /** Declare a direct conflict between two blocks (symmetric). */
  addConflict(a: Hash, b: Hash): void {
    const aKey = a.toPrimitive();
    const bKey = b.toPrimitive();
    this.getOrCreateSet(this.conflicts, aKey).add(bKey);
    this.getOrCreateSet(this.conflicts, bKey).add(aKey);
  }

  /**
   * Load a claim mask chunk for a block, potentially discovering new conflicts.
   * Returns newly discovered conflict pairs.
   */
  loadClaimMaskChunk(
    hash: Hash,
    chunkIndex: number,
    data: Uint8Array,
  ): [Hash, Hash][] {
    const key = hash.toPrimitive();
    const block = this.provider.getBlock(hash);
    if (!block) return [];

    // Update the cached net claim mask
    let netMask = this.netClaimMasks.get(key);
    if (!netMask) {
      const anchorOutputCount = this.provider.getAnchorOutputCount(block);
      netMask = BitVector.unknown(anchorOutputCount);
      this.netClaimMasks.set(key, netMask);
    }

    netMask.loadChunk(chunkIndex, data);

    // Re-check conflicts with siblings
    const newConflicts: [Hash, Hash][] = [];
    const anchorHash = this.provider.getAnchor(block);
    if (anchorHash) {
      const siblings = this.anchorChildren.get(anchorHash.toPrimitive());
      if (siblings) {
        for (const sibKey of siblings) {
          if (sibKey === key) continue;
          // Skip if already known conflict
          if (this.conflicts.get(key)?.has(sibKey)) continue;
          const sibMask = this.netClaimMasks.get(sibKey);
          if (sibMask && netMask.intersects(sibMask)) {
            this.addConflict(hash, this.blocks.get(sibKey)!);
            newConflicts.push([hash, this.blocks.get(sibKey)!]);
          }
        }
      }
    }

    return newConflicts;
  }

  /**
   * Infer a claim bit from a descendant block upward to an ancestor.
   * If a subtree block claims an output, the aggregator must also claim it.
   * Returns newly discovered conflict pairs.
   */
  inferClaimFromDescendant(
    ancestorHash: Hash,
    bitIndex: number,
  ): [Hash, Hash][] {
    const key = ancestorHash.toPrimitive();
    let netMask = this.netClaimMasks.get(key);

    if (!netMask) {
      const block = this.provider.getBlock(ancestorHash);
      if (!block) return [];
      const anchorOutputCount = this.provider.getAnchorOutputCount(block);
      netMask = BitVector.unknown(anchorOutputCount);
      this.netClaimMasks.set(key, netMask);
    }

    // If already known, nothing to do
    if (netMask.get(bitIndex)) return [];

    netMask.set(bitIndex, true);

    // Check if this new bit causes conflicts with siblings
    const newConflicts: [Hash, Hash][] = [];
    const block = this.provider.getBlock(ancestorHash);
    if (!block) return [];
    const anchorHash = this.provider.getAnchor(block);
    if (anchorHash) {
      const siblings = this.anchorChildren.get(anchorHash.toPrimitive());
      if (siblings) {
        for (const sibKey of siblings) {
          if (sibKey === key) continue;
          if (this.conflicts.get(key)?.has(sibKey)) continue;
          const sibMask = this.netClaimMasks.get(sibKey);
          if (sibMask && sibMask.get(bitIndex)) {
            this.addConflict(ancestorHash, this.blocks.get(sibKey)!);
            newConflicts.push([ancestorHash, this.blocks.get(sibKey)!]);
          }
        }
      }
    }

    return newConflicts;
  }

  // -- Queries ----------------------------------------------------

  /** Check if two blocks are in conflict. */
  hasConflict(a: Hash, b: Hash): boolean {
    return this.conflicts.get(a.toPrimitive())?.has(b.toPrimitive()) ?? false;
  }

  /** Get all blocks that conflict with the given block. */
  getConflicts(hash: Hash): ReadonlySet<HashPrimitive> {
    return this.conflicts.get(hash.toPrimitive()) ?? new Set();
  }

  /** Get the net claim mask for a block (against its anchor's output space). */
  getNetClaimMask(hash: Hash): BitVector | undefined {
    return this.netClaimMasks.get(hash.toPrimitive());
  }

  /**
   * Rebase a block's net claim mask forward through the anchor chain
   * to a target anchor. Returns the rebased mask, or undefined if the
   * chain cannot be walked.
   *
   * Also returns whether any chain conflict was detected during rebasing.
   */
  rebase(
    hash: Hash,
    targetAnchorHash: Hash,
  ): { mask: BitVector; chainConflict: boolean } | undefined {
    const key = hash.toPrimitive();
    const targetKey = targetAnchorHash.toPrimitive();

    const cachedMask = this.netClaimMasks.get(key);
    if (!cachedMask) return undefined;

    let mask: BitVector = cachedMask.clone();

    // Get the block's anchor
    const block = this.provider.getBlock(hash);
    if (!block) return undefined;
    const anchorHash = this.provider.getAnchor(block);
    if (!anchorHash) return undefined;

    // Walk from the block's anchor forward to targetAnchorHash
    // First, collect the chain from anchor to target
    const chain = this.findChain(anchorHash, targetAnchorHash);
    if (!chain) return undefined;

    let chainConflict = false;

    // Apply each block in the chain as a transformation
    for (const chainHash of chain) {
      const chainBlock = this.provider.getBlock(chainHash);
      if (!chainBlock) return undefined;

      const netMask = this.computeNetClaimMask(chainBlock);
      if (!netMask) {
        // Block has no claims, but may produce outputs
        const outputCount = this.provider.getOutputCount(chainBlock);
        const anchorOutputCount = this.provider.getAnchorOutputCount(chainBlock);
        const newOutputs = outputCount - anchorOutputCount;
        if (newOutputs > 0) {
          // Shift everything by the new outputs
          const emptyMask = BitVector.empty(anchorOutputCount);
          const rebaseResult: RebaseResult = mask.rebase({
            claimMask: emptyMask,
            newOutputCount: newOutputs,
          });
          mask = rebaseResult.rebased;
        }
        continue;
      }

      const outputCount = this.provider.getOutputCount(chainBlock);
      const anchorOutputCount = this.provider.getAnchorOutputCount(chainBlock);
      const newOutputs = outputCount - (anchorOutputCount - netMask.popcount());

      const rebaseResult: RebaseResult = mask.rebase({
        claimMask: netMask,
        newOutputCount: newOutputs,
      });

      if (rebaseResult.chainConflict) chainConflict = true;
      mask = rebaseResult.rebased;
    }

    return { mask, chainConflict };
  }

  // -- Internals --------------------------------------------------

  /**
   * Compute the net claim mask for a block against its anchor's output space.
   * This combines the subtree claim mask with the block's own claims,
   * projecting the block's own claims back into anchor space.
   */
  private computeNetClaimMask(block: BlockType): BitVector | null {
    const anchorOutputCount = this.provider.getAnchorOutputCount(block);
    if (anchorOutputCount === 0) return null;

    const subtreeClaimMask = this.provider.getClaimMask(block);
    const ownClaims = this.provider.getOwnClaims(block);
    const aggregateOutputCounts = this.provider.getAggregateOutputCounts(block);

    // The subtree claim mask records which anchor outputs are claimed by subtrees.
    // We use a snapshot of it for index mapping (own claims are relative to the
    // output vector after subtree removals, not after own removals).
    const subtreeMask: BitVector = subtreeClaimMask
      ? subtreeClaimMask.clone()
      : BitVector.empty(anchorOutputCount);

    // Net mask starts as a copy of subtree claims, then accumulates own claims.
    const netMask = subtreeMask.clone();

    // The block's own claims are against the output vector AFTER subtree
    // transformations. We need to map them back to anchor output space.
    // After subtrees: vector = [subtree outputs..., surviving anchor outputs...]
    const totalSubtreeOutputs = aggregateOutputCounts.reduce(
      (sum, c) => sum + c,
      0,
    );

    // Map own claims that hit anchor outputs back to anchor indices
    for (let i = 0; i < ownClaims.length; i++) {
      if (!ownClaims.get(i)) continue;

      if (i < totalSubtreeOutputs) {
        // This claim is on a subtree output — internal to the tree,
        // doesn't affect the anchor claim mask
        continue;
      }

      // This claim is on a surviving anchor output.
      // Map it back to the original anchor index using the subtree mask
      // (not netMask, which is being mutated).
      const survivingIdx = i - totalSubtreeOutputs;
      const anchorIdx = this.mapSurvivingToOriginal(
        survivingIdx,
        subtreeMask,
      );
      if (anchorIdx !== -1) {
        netMask.set(anchorIdx, true);
      }
    }

    return netMask;
  }

  /**
   * Map a surviving output index back to its original anchor index,
   * given a claim mask that has removed some outputs.
   */
  private mapSurvivingToOriginal(
    survivingIdx: number,
    claimMask: BitVector,
  ): number {
    let survived = 0;
    for (let i = 0; i < claimMask.length; i++) {
      if (!claimMask.get(i)) {
        if (survived === survivingIdx) return i;
        survived++;
      }
    }
    return -1;
  }

  /**
   * Find the chain of blocks from `from` to `to` (exclusive of `from`,
   * inclusive of `to`). Returns the blocks in order from `from` toward `to`.
   * Returns null if no path exists.
   */
  private findChain(from: Hash, to: Hash): Hash[] | null {
    const fromKey = from.toPrimitive();
    const toKey = to.toPrimitive();

    if (fromKey === toKey) return [];

    // Walk backward from `to` to `from`, collecting the path
    const path: Hash[] = [];
    let current = to;
    let currentKey = toKey;

    while (currentKey !== fromKey) {
      path.push(current);
      const block = this.provider.getBlock(current);
      if (!block) return null;
      const anchor = this.provider.getAnchor(block);
      if (!anchor) return null;
      current = anchor;
      currentKey = current.toPrimitive();
    }

    // Reverse to get from -> to order
    path.reverse();
    return path;
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
}
