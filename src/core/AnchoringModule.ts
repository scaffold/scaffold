// Protocol spec: docs/protocol/anchoring.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { mapOriginalToSurviving, mapSurvivingToOriginal } from './OutputSpace.ts';

// -- Provider -----------------------------------------------------

/**
 * Provider interface for the anchoring module to access block data.
 * The module is fully encapsulated -- it knows nothing about block internals
 * beyond what this interface exposes.
 */
export interface AnchoringProvider<BlockType> {
  /** Return the block object for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the hash of a block. */
  getHash(block: BlockType): Hash;

  /** Return the anchor hash. ZERO_HASH for genesis. */
  getAnchor(block: BlockType): Hash;

  /** Return the number of this block's own outputs. */
  getOwnOutputCount(block: BlockType): number;

  /** Return the total output count after all transformations. */
  getOutputCount(block: BlockType): number;

  /**
   * Return the subtree claim mask: a sorted array of anchor output indices
   * consumed by the block's subtrees.
   * Returns null if this block has no subtrees (leaf block).
   */
  getClaimMask(block: BlockType): readonly number[] | null;

  /**
   * Return the block's own claim indices as an array of integers.
   * These are indices into the block's output space (after subtree transformations).
   */
  getOwnClaims(block: BlockType): number[];

  /** Return ordered list of aggregate (subtree root) hashes. Empty if no subtrees. */
  getAggregates(block: BlockType): Hash[];

  /** Return per-subtree output counts. Empty if no subtrees. */
  getAggregateOutputCounts(block: BlockType): number[];

  /**
   * Return the hashes of blocks that aggregate the given block.
   * Used for path finding -- walking "up" through aggregation links.
   */
  getAggregatorsOf(hash: Hash): Hash[];
}

// -- Path step types ----------------------------------------------

type StepDirection = 'forward' | 'backward';
type StepType = 'anchor' | 'aggregate';

interface PathStep {
  direction: StepDirection;
  type: StepType;
  /** The block being stepped through. */
  block: Hash;
  /** For aggregate steps, the index of the aggregate in the parent's aggregates list. */
  aggregateIndex?: number;
}

// -- Module -------------------------------------------------------

/**
 * The anchoring module computes where a block attaches to the graph and
 * how outputs are addressed across blocks.
 *
 * Core algorithms:
 * - rebaseOutputIndex: map an output from one block's space to another's
 * - resolveAnchor: compute anchor + aggregates from include/exclude constraints
 *
 * Fully self-contained -- depends only on AnchoringProvider and Hash.
 */
export class AnchoringModule<BlockType> {
  private readonly provider: AnchoringProvider<BlockType>;

  constructor(provider: AnchoringProvider<BlockType>) {
    this.provider = provider;
  }

  // -- Public API -------------------------------------------------

  /**
   * Given an output at block.outputs[outputIndex] (an output in block's own
   * outputs array), find its position in ontoBlock's output space.
   *
   * Returns null if the output was consumed by an intermediate block.
   *
   * Works in both directions -- ontoBlock can be an ancestor or descendant
   * of block, and the path can go through anchor links and/or aggregation links.
   */
  rebaseOutputIndex(
    blockHash: Hash,
    outputIndex: number,
    ontoBlockHash: Hash,
  ): number | null {
    if (Hash.equals(blockHash, ontoBlockHash)) {
      return outputIndex;
    }

    const path = this.findPath(blockHash, ontoBlockHash);
    if (!path) return null;

    // Convert outputIndex from own-outputs position to the block's output space index.
    // Own outputs are at positions [0..ownOutputCount) in the block's output space,
    // which is also where they sit before any self-claim adjustments.
    let currentIndex = outputIndex;

    for (const step of path) {
      const block = this.provider.getBlock(step.block);
      if (!block) return null;

      let result: number | null;
      if (step.direction === 'forward' && step.type === 'anchor') {
        result = this.forwardAnchorStep(currentIndex, block);
      } else if (step.direction === 'forward' && step.type === 'aggregate') {
        result = this.forwardAggregateStep(currentIndex, block, step.aggregateIndex!);
      } else if (step.direction === 'backward' && step.type === 'anchor') {
        result = this.backwardAnchorStep(currentIndex, block);
      } else {
        result = this.backwardAggregateStep(currentIndex, block, step.aggregateIndex!);
      }

      if (result === null) return null;
      currentIndex = result;
    }

    return currentIndex;
  }

  /**
   * Given blocks to include and exclude, compute the anchor and which blocks
   * must be aggregated.
   *
   * A block X is reachable if it is either an ancestor of the anchor (in the
   * anchor chain) or an aggregated subtree.
   *
   * Returns an error string if the request is infeasible (include/exclude conflict).
   */
  resolveAnchor(request: {
    includeBlocks: Hash[];
    excludeBlocks: Hash[];
    declaredWeight: number;
  }): { anchor: Hash; aggregates: Hash[] } | { error: string } {
    const { includeBlocks, excludeBlocks } = request;

    if (includeBlocks.length === 0) {
      return { error: 'includeBlocks must not be empty' };
    }

    // 1. Deduplicate: remove blocks that are ancestors of other included blocks.
    //    If A is an ancestor of B, including A is redundant since B already
    //    covers A via its anchor chain.
    const deduplicated = this.deduplicateBranches(includeBlocks);

    // 2. Check exclude constraints
    const excludeSet = new Set(excludeBlocks.map((h) => h.toPrimitive()));
    for (const blockHash of deduplicated) {
      const chain = this.buildAncestry(blockHash);
      if (!chain) return { error: `cannot build ancestry for ${blockHash.toHex().slice(0, 8)}` };
      for (const ch of chain) {
        if (excludeSet.has(ch.toPrimitive())) {
          if (ch.toPrimitive() === blockHash.toPrimitive()) {
            return { error: 'included block is also excluded' };
          }
          return { error: 'include/exclude conflict: included block requires excluded ancestor' };
        }
      }
    }

    // 3. Single block remaining: use it as anchor, no aggregates
    if (deduplicated.length === 1) {
      return { anchor: deduplicated[0], aggregates: [] };
    }

    // 4. Multiple blocks: find LCA to use as anchor, blocks become aggregates
    const chains: Hash[][] = [];
    for (const blockHash of deduplicated) {
      const chain = this.buildAncestry(blockHash);
      if (!chain) return { error: `cannot build ancestry for ${blockHash.toHex().slice(0, 8)}` };
      chains.push(chain);
    }

    const chainSets = chains.map((c) => new Set(c.map((h) => h.toPrimitive())));
    const sharedSpine = chains[0].filter((h) => {
      const key = h.toPrimitive();
      return chainSets.every((s) => s.has(key));
    });

    if (sharedSpine.length === 0) {
      return { error: 'no common ancestor found' };
    }

    // LCA is the deepest block on the shared spine
    const anchor = sharedSpine[0];

    // Check that the anchor doesn't pass through an excluded block
    const anchorChain = this.buildAncestry(anchor);
    if (anchorChain) {
      for (const ch of anchorChain) {
        if (excludeSet.has(ch.toPrimitive()) && !Hash.equals(ch, anchor)) {
          return { error: 'anchor passes through excluded block' };
        }
      }
    }

    // Aggregates are the deduplicated blocks (all are distinct branches off the LCA)
    const aggregates = deduplicated;

    // Validate: each aggregate's anchor must be in the chosen anchor's chain
    if (anchorChain) {
      const anchorSet = new Set(anchorChain.map((h) => h.toPrimitive()));
      for (const aggHash of aggregates) {
        const aggBlock = this.provider.getBlock(aggHash);
        if (!aggBlock) continue;
        const aggAnchor = this.provider.getAnchor(aggBlock);
        if (!Hash.equals(aggAnchor, ZERO_HASH) && !anchorSet.has(aggAnchor.toPrimitive())) {
          return { error: `aggregate anchor not in chosen anchor's chain` };
        }
      }
    }

    return { anchor, aggregates };
  }

  // -- Step implementations ---------------------------------------

  /**
   * Case 1: Forward from A.anchor's post-claim output space into A's output space.
   *
   * The index references an output in A.anchor's post-claim output space.
   * A's subtree claim mask removes some of those outputs; surviving ones
   * land in A's "surviving anchor outputs" zone.
   */
  forwardAnchorStep(index: number, block: BlockType): number | null {
    const claimMask = this.provider.getClaimMask(block);
    const ownOutputCount = this.provider.getOwnOutputCount(block);
    const aggregates = this.provider.getAggregates(block);
    const aggOutputCounts = this.provider.getAggregateOutputCounts(block);
    const totalSubtreeOutputs = aggOutputCounts.reduce((s, c) => s + c, 0);

    if (claimMask && this.isClaimed(claimMask, index)) {
      return null; // consumed by subtrees
    }

    const claimedBefore = claimMask ? this.countBefore(claimMask, index) : 0;
    const survivingIndex = index - claimedBefore;

    // Position in output space: own outputs, then subtree outputs, then surviving anchor
    return ownOutputCount + totalSubtreeOutputs + survivingIndex;
  }

  /**
   * Case 2: Forward from aggregate S_n's output space into the parent's output space.
   *
   * Later subtrees may have claimed outputs from S_n. We trace through those claims.
   */
  forwardAggregateStep(
    index: number,
    parentBlock: BlockType,
    aggregateIndex: number,
  ): number | null {
    const aggregates = this.provider.getAggregates(parentBlock);
    const aggOutputCounts = this.provider.getAggregateOutputCounts(parentBlock);
    const ownOutputCount = this.provider.getOwnOutputCount(parentBlock);

    let currentIndex = index;

    // Check if later subtrees claim this output.
    // Later subtrees (higher index) are applied after earlier ones.
    // We need to check if any later subtree that chains from this subtree
    // claims the current output.
    for (let m = aggregateIndex + 1; m < aggregates.length; m++) {
      const laterBlock = this.provider.getBlock(aggregates[m]);
      if (!laterBlock) continue;

      // Check if this later subtree anchors to S_n or a descendant of S_n.
      // If so, its claims reference the output space that includes S_n.
      const laterAnchor = this.provider.getAnchor(laterBlock);
      if (this.isInSubtreeChain(laterAnchor, aggregates, aggregateIndex, m)) {
        const laterClaimMask = this.provider.getClaimMask(laterBlock);
        const laterOwnClaims = this.provider.getOwnClaims(laterBlock);
        const laterAggOutputCounts = this.provider.getAggregateOutputCounts(laterBlock);
        const laterTotalSubtreeOutputs = laterAggOutputCounts.reduce((s, c) => s + c, 0);

        // Build the effective claim mask for the later block against its anchor's space
        // The later block's claimMask covers its anchor's output space.
        // We need to check if currentIndex is claimed.
        if (laterClaimMask && this.isClaimed(laterClaimMask, currentIndex)) {
          return null; // consumed by later subtree's subtrees
        }

        // Check own claims of the later block too
        const laterOwnOutputCount = this.provider.getOwnOutputCount(laterBlock);
        // Map currentIndex to position in later block's output vector
        const claimedBefore = laterClaimMask ? this.countBefore(laterClaimMask, currentIndex) : 0;
        const survivingIdx = currentIndex - claimedBefore;
        const posInLater = laterOwnOutputCount + laterTotalSubtreeOutputs + survivingIdx;

        // Check if later block's own claims hit this position
        if (laterOwnClaims.includes(posInLater)) {
          return null; // consumed by later subtree's own claims
        }

        // Convert to post-claim position: subtract own claims before this position
        let ownClaimsBefore = 0;
        for (const c of laterOwnClaims) {
          if (c < posInLater) ownClaimsBefore++;
        }
        currentIndex = posInLater - ownClaimsBefore;
      }
    }

    // Compute offset: own outputs + outputs from all subtrees after aggregateIndex
    // The subtree ordering in the output space is: last subtree first, then second-to-last, etc.
    // But per the spec, the offset is computed based on the aggregate ordering.
    // offset = ownOutputCount + sum(outputCounts of subtrees after S_n)
    // But after processing through later subtrees, currentIndex is already in the
    // output space of the last chained subtree. We need the offset to place it
    // in the parent's output space.

    // If no later subtrees chain from this one, the section for S_n in the parent is:
    // After own outputs + all later subtree sections.
    // With chained subtrees, the chaining has already been handled above,
    // and currentIndex is now in the last chaining subtree's output space.

    // Find the last subtree that chains from aggregateIndex
    let lastChainedIdx = aggregateIndex;
    for (let m = aggregateIndex + 1; m < aggregates.length; m++) {
      const laterBlock = this.provider.getBlock(aggregates[m]);
      if (!laterBlock) continue;
      const laterAnchor = this.provider.getAnchor(laterBlock);
      if (this.isInSubtreeChain(laterAnchor, aggregates, aggregateIndex, m)) {
        lastChainedIdx = m;
      }
    }

    // The output position in the parent's output space:
    // ownOutputCount + sum of output counts for subtrees after lastChainedIdx
    let offset = ownOutputCount;
    for (let m = aggregates.length - 1; m > lastChainedIdx; m--) {
      offset += aggOutputCounts[m];
    }

    return offset + currentIndex;
  }

  /**
   * Case 3: Backward from A's output space to A.anchor's post-claim output space.
   *
   * If the index is in A's own outputs zone, returns null (doesn't exist in anchor).
   * If in subtree zone, returns null (caller should go through aggregation step).
   * If in surviving anchor zone, maps back to original anchor index.
   */
  backwardAnchorStep(index: number, block: BlockType): number | null {
    const ownOutputCount = this.provider.getOwnOutputCount(block);
    const aggOutputCounts = this.provider.getAggregateOutputCounts(block);
    const totalSubtreeOutputs = aggOutputCounts.reduce((s, c) => s + c, 0);

    if (index < ownOutputCount) {
      return null; // own output, doesn't exist in anchor's space
    }

    if (index < ownOutputCount + totalSubtreeOutputs) {
      return null; // subtree output, not directly in anchor's space
    }

    // Surviving anchor section
    const survivingIndex = index - ownOutputCount - totalSubtreeOutputs;
    const claimMask = this.provider.getClaimMask(block);

    if (!claimMask) {
      // No subtrees, so no claims -- direct mapping
      return survivingIndex;
    }

    const anchorIdx = mapSurvivingToOriginal(survivingIndex, claimMask);
    return anchorIdx === -1 ? null : anchorIdx;
  }

  /**
   * Case 4: Backward from the parent's output space to aggregate S_n's output space.
   *
   * The index must be in S_n's section of the parent's output space.
   */
  backwardAggregateStep(
    index: number,
    parentBlock: BlockType,
    aggregateIndex: number,
  ): number | null {
    const ownOutputCount = this.provider.getOwnOutputCount(parentBlock);
    const aggOutputCounts = this.provider.getAggregateOutputCounts(parentBlock);
    const aggregates = this.provider.getAggregates(parentBlock);

    // Find the last subtree that chains from aggregateIndex
    let lastChainedIdx = aggregateIndex;
    for (let m = aggregateIndex + 1; m < aggregates.length; m++) {
      const laterBlock = this.provider.getBlock(aggregates[m]);
      if (!laterBlock) continue;
      const laterAnchor = this.provider.getAnchor(laterBlock);
      if (this.isInSubtreeChain(laterAnchor, aggregates, aggregateIndex, m)) {
        lastChainedIdx = m;
      }
    }

    // Section start: after own outputs + all later non-chained subtrees
    let sectionStart = ownOutputCount;
    for (let m = aggregates.length - 1; m > lastChainedIdx; m--) {
      sectionStart += aggOutputCounts[m];
    }

    const sectionEnd = sectionStart + aggOutputCounts[lastChainedIdx];

    if (index < sectionStart || index >= sectionEnd) {
      return null; // not in S_n's section
    }

    let localIndex = index - sectionStart;

    // Undo later subtree transformations in reverse order
    for (let m = lastChainedIdx; m > aggregateIndex; m--) {
      const laterBlock = this.provider.getBlock(aggregates[m]);
      if (!laterBlock) continue;
      const laterAnchor = this.provider.getAnchor(laterBlock);
      if (!this.isInSubtreeChain(laterAnchor, aggregates, aggregateIndex, m)) continue;

      const laterOwnOutputCount = this.provider.getOwnOutputCount(laterBlock);
      const laterAggOutputCounts = this.provider.getAggregateOutputCounts(laterBlock);
      const laterTotalSubtreeOutputs = laterAggOutputCounts.reduce((s, c) => s + c, 0);
      const laterClaimMask = this.provider.getClaimMask(laterBlock);

      if (localIndex < laterOwnOutputCount + laterTotalSubtreeOutputs) {
        return null; // this output is from the later subtree, not from S_n
      }

      const survivingIndex = localIndex - laterOwnOutputCount - laterTotalSubtreeOutputs;

      // Expand: insert back the claimed slots
      if (laterClaimMask) {
        const original = mapSurvivingToOriginal(survivingIndex, laterClaimMask);
        if (original === -1) return null;
        localIndex = original;
      } else {
        localIndex = survivingIndex;
      }
    }

    return localIndex;
  }

  // -- Path finding -----------------------------------------------

  /**
   * Find a path from `from` to `to` as a sequence of steps.
   * Each step is a forward or backward anchor/aggregate step.
   */
  findPath(from: Hash, to: Hash): PathStep[] | null {
    if (Hash.equals(from, to)) return [];

    // Build ancestry for both blocks
    const fromAncestry = this.buildAncestry(from);
    const toAncestry = this.buildAncestry(to);

    if (!fromAncestry || !toAncestry) return null;

    // Case 1: `to` is in `from`'s anchor chain -- walk forward
    const forwardPath = this.buildForwardPath(from, to);
    if (forwardPath) return forwardPath;

    // Case 2: `from` is in `to`'s anchor chain -- walk backward
    const backwardPath = this.buildBackwardPath(from, to);
    if (backwardPath) return backwardPath;

    // Case 3: They share a common ancestor -- walk backward then forward
    const lca = this.findLCA(fromAncestry, toAncestry);
    if (lca) {
      const backPart = this.buildBackwardPath(from, lca);
      const fwdPart = this.buildForwardPath(lca, to);
      if (backPart && fwdPart) {
        return [...backPart, ...fwdPart];
      }
    }

    // Case 4: Connected through aggregation
    // Check if `to` aggregates something in `from`'s ancestry
    const aggPath = this.findAggregationPath(from, to, fromAncestry, toAncestry);
    if (aggPath) return aggPath;

    return null;
  }

  // -- Internals --------------------------------------------------

  /** Check if an index is present in a sorted claim mask. */
  private isClaimed(mask: readonly number[], index: number): boolean {
    let lo = 0;
    let hi = mask.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (mask[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo < mask.length && mask[lo] === index;
  }

  /** Count elements in a sorted claim mask that are less than index. */
  private countBefore(mask: readonly number[], index: number): number {
    let lo = 0;
    let hi = mask.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (mask[mid] < index) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Check if `anchorHash` is the hash of one of the aggregates in
   * the range [startIdx..endIdx), or a descendant of one of them.
   * This determines whether a later subtree chains from an earlier subtree.
   *
   * A later subtree S_m chains from an earlier subtree S_n if S_m's anchor
   * is S_n itself or a block in S_n's subtree (i.e., S_m anchors to S_n
   * or one of S_n's descendants that is also an aggregate).
   */
  private isInSubtreeChain(
    anchorHash: Hash,
    aggregates: Hash[],
    startIdx: number,
    endIdx: number,
  ): boolean {
    // Direct check: does anchorHash match any aggregate in [startIdx..endIdx)?
    for (let i = startIdx; i < endIdx; i++) {
      if (Hash.equals(anchorHash, aggregates[i])) return true;
    }

    // Walk anchorHash's anchor chain upward to see if it reaches one of the aggregates.
    // This handles the case where anchorHash is a descendant of an aggregate.
    let current = anchorHash;
    const visited = new Set<HashPrimitive>();
    while (!Hash.equals(current, ZERO_HASH)) {
      const key = current.toPrimitive();
      if (visited.has(key)) break;
      visited.add(key);

      const block = this.provider.getBlock(current);
      if (!block) break;
      const anchor = this.provider.getAnchor(block);

      for (let i = startIdx; i < endIdx; i++) {
        if (Hash.equals(anchor, aggregates[i])) return true;
      }
      current = anchor;
    }

    return false;
  }

  /** Build the anchor chain from a block back to genesis. Returns array of hashes. */
  private buildAncestry(hash: Hash): Hash[] | null {
    const ancestry: Hash[] = [];
    let current = hash;
    const visited = new Set<HashPrimitive>();

    while (!Hash.equals(current, ZERO_HASH)) {
      const key = current.toPrimitive();
      if (visited.has(key)) return null; // cycle detection
      visited.add(key);
      ancestry.push(current);

      const block = this.provider.getBlock(current);
      if (!block) return ancestry; // partial knowledge
      current = this.provider.getAnchor(block);
    }

    return ancestry;
  }

  /**
   * Build a forward path (sequence of forward steps) from `from` to `to`.
   * `to` must be a descendant of `from` via anchor chain.
   */
  private buildForwardPath(from: Hash, to: Hash): PathStep[] | null {
    if (Hash.equals(from, to)) return [];

    // Walk backward from `to` to `from`, collecting blocks
    const chain: Hash[] = [];
    let current = to;

    while (!Hash.equals(current, from)) {
      const block = this.provider.getBlock(current);
      if (!block) return null;

      // Check if current aggregates `from` or has from in a subtree
      const aggregates = this.provider.getAggregates(block);
      for (let i = 0; i < aggregates.length; i++) {
        if (Hash.equals(aggregates[i], from)) {
          // from is an aggregate of current -- forward aggregate step
          chain.push(current);
          chain.reverse();
          const steps: PathStep[] = [];
          // All intermediate steps are forward anchor steps
          for (let j = 0; j < chain.length - 1; j++) {
            steps.push({ direction: 'forward', type: 'anchor', block: chain[j] });
          }
          // Last step is aggregate
          steps.push({ direction: 'forward', type: 'aggregate', block: current, aggregateIndex: i });
          return steps;
        }
      }

      chain.push(current);
      const anchor = this.provider.getAnchor(block);
      if (Hash.equals(anchor, ZERO_HASH)) return null; // reached genesis without finding `from`
      current = anchor;
    }

    // Reverse to get from -> to order, each is a forward anchor step
    chain.reverse();
    return chain.map((blockHash) => ({
      direction: 'forward' as StepDirection,
      type: 'anchor' as StepType,
      block: blockHash,
    }));
  }

  /**
   * Build a backward path from `from` to `to`.
   * `from` must be a descendant of `to` via anchor chain.
   */
  private buildBackwardPath(from: Hash, to: Hash): PathStep[] | null {
    if (Hash.equals(from, to)) return [];

    const steps: PathStep[] = [];
    let current = from;

    while (!Hash.equals(current, to)) {
      const block = this.provider.getBlock(current);
      if (!block) return null;

      const anchor = this.provider.getAnchor(block);
      if (Hash.equals(anchor, ZERO_HASH) && !Hash.equals(to, ZERO_HASH)) return null;

      steps.push({ direction: 'backward', type: 'anchor', block: current });
      current = anchor;
    }

    return steps;
  }

  /**
   * Find the lowest common ancestor of two blocks via their anchor chains.
   */
  /**
   * Get the depth of `ancestor` in the anchor chain starting from `from`.
   * Depth 0 means from === ancestor. Returns undefined if not found.
   */
  private getDepth(from: Hash, ancestor: Hash): number | undefined {
    let current = from;
    let depth = 0;
    const visited = new Set<HashPrimitive>();

    while (!Hash.equals(current, ZERO_HASH)) {
      if (Hash.equals(current, ancestor)) return depth;
      const key = current.toPrimitive();
      if (visited.has(key)) return undefined;
      visited.add(key);
      const block = this.provider.getBlock(current);
      if (!block) return undefined;
      current = this.provider.getAnchor(block);
      depth++;
    }
    if (Hash.equals(ancestor, ZERO_HASH)) return depth;
    return undefined;
  }

  /**
   * Remove blocks that are ancestors of other blocks in the list.
   * For blocks on the same branch, keep only the deepest.
   */
  private deduplicateBranches(blocks: Hash[]): Hash[] {
    if (blocks.length <= 1) return [...blocks];

    const result: Hash[] = [];
    for (let i = 0; i < blocks.length; i++) {
      let isAncestorOfAnother = false;
      for (let j = 0; j < blocks.length; j++) {
        if (i === j) continue;
        const depth = this.getDepth(blocks[j], blocks[i]);
        if (depth !== undefined && depth > 0) {
          isAncestorOfAnother = true;
          break;
        }
      }
      if (!isAncestorOfAnother) {
        result.push(blocks[i]);
      }
    }
    return result;
  }

  private findLCA(fromAncestry: Hash[], toAncestry: Hash[]): Hash | null {
    const fromSet = new Set(fromAncestry.map((h) => h.toPrimitive()));

    for (const h of toAncestry) {
      if (fromSet.has(h.toPrimitive())) return h;
    }

    return null;
  }

  /**
   * Find a path through aggregation links.
   * Checks if any block in `to`'s ancestry aggregates a block in `from`'s ancestry.
   */
  private findAggregationPath(
    from: Hash,
    to: Hash,
    fromAncestry: Hash[],
    toAncestry: Hash[],
  ): PathStep[] | null {
    const fromSet = new Set(fromAncestry.map((h) => h.toPrimitive()));

    // Walk to's ancestry looking for aggregators that aggregate from's chain
    for (const toHash of toAncestry) {
      const toBlock = this.provider.getBlock(toHash);
      if (!toBlock) continue;

      const aggregates = this.provider.getAggregates(toBlock);
      for (let i = 0; i < aggregates.length; i++) {
        const aggHash = aggregates[i];

        // Check if the aggregate or its ancestry intersects from's ancestry
        if (fromSet.has(aggHash.toPrimitive())) {
          // from's chain reaches aggHash, which is aggregated by toHash
          // Path: backward from `from` to aggHash, then forward aggregate to toHash,
          // then forward anchor to `to`
          const backPart = this.buildBackwardPath(from, aggHash);
          if (!backPart) continue;

          const aggStep: PathStep = {
            direction: 'forward',
            type: 'aggregate',
            block: toHash,
            aggregateIndex: i,
          };

          const fwdPart = this.buildForwardPath(toHash, to);
          if (!fwdPart) continue;

          return [...backPart, aggStep, ...fwdPart];
        }

        // Check if aggHash's ancestry intersects from's ancestry
        const aggAncestry = this.buildAncestry(aggHash);
        if (!aggAncestry) continue;

        for (const ah of aggAncestry) {
          if (fromSet.has(ah.toPrimitive())) {
            const backPart = this.buildBackwardPath(from, ah);
            if (!backPart) continue;

            // Forward from ah to aggHash
            const fwdToAgg = this.buildForwardPath(ah, aggHash);
            if (!fwdToAgg) continue;

            const aggStep: PathStep = {
              direction: 'forward',
              type: 'aggregate',
              block: toHash,
              aggregateIndex: i,
            };

            const fwdPart = this.buildForwardPath(toHash, to);
            if (!fwdPart) continue;

            return [...backPart, ...fwdToAgg, aggStep, ...fwdPart];
          }
        }
      }
    }

    return null;
  }
}
