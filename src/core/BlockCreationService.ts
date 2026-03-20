import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { BitVector, RebaseResult } from './BitVector.ts';
import {
  AGGREGATION_CONTRACT,
  Block,
  BlockStore,
  getAggregationData,
  getBlockClaimMask,
  getBlockWeightVector,
} from './Block.ts';
import { BlockCreationModule, BlockCreationProvider } from './BlockCreationModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class BlockCreationProviderAdapter implements BlockCreationProvider<Block> {
  constructor(private readonly store: BlockStore) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getHash(block: Block): Hash {
    return block.hash;
  }

  getAnchor(block: Block): Hash {
    return block.anchor;
  }

  getOutputCount(block: Block): number {
    return this.resolveOutputCount(block);
  }

  getWeightVector(block: Block): number[] {
    return getBlockWeightVector(block);
  }

  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined {
    return this.store.getAnchorDepth(from, ancestor);
  }

  getRebasedClaimMask(blockHash: Hash, targetAnchor: Hash): BitVector | null {
    const block = this.store.get(blockHash);
    if (!block) return null;

    const anchorHash = block.anchor;
    if (Hash.equals(anchorHash, ZERO_HASH)) return null;

    const anchorBlock = this.store.get(anchorHash);
    if (!anchorBlock) return null;

    const anchorOutputCount = this.resolveOutputCount(anchorBlock);
    let mask = getBlockClaimMask(block, anchorOutputCount);

    // Find chain from block's anchor to targetAnchor
    const chain = this.findChain(anchorHash, targetAnchor);
    if (!chain) return null;

    // Apply each chain block's transformation
    for (const chainHash of chain) {
      const chainBlock = this.store.get(chainHash);
      if (!chainBlock) return null;

      const chainAnchorBlock = this.store.get(chainBlock.anchor);
      if (!chainAnchorBlock) return null;

      const chainAnchorOutputCount = this.resolveOutputCount(chainAnchorBlock);
      const netMask = getBlockClaimMask(chainBlock, chainAnchorOutputCount);

      const outputCount = this.resolveOutputCount(chainBlock);
      const newOutputs = outputCount - (chainAnchorOutputCount - netMask.popcount());

      const rebaseResult: RebaseResult = mask.rebase({
        claimMask: netMask,
        newOutputCount: newOutputs,
      });
      mask = rebaseResult.rebased;
    }

    return mask;
  }

  getAggregationContract(): Hash {
    return AGGREGATION_CONTRACT;
  }

  /**
   * Compute the full extended output count for any block.
   * For aggregation blocks, reads from AggregationData.
   * For leaf blocks, resolves through the anchor chain:
   *   anchorOutputCount + ownOutputs - totalClaims
   * For genesis (no anchor), returns block.outputs.length.
   */
  private resolveOutputCount(block: Block): number {
    const aggData = getAggregationData(block);
    if (aggData) return aggData.outputCount;

    // Leaf or genesis
    if (Hash.equals(block.anchor, ZERO_HASH)) {
      return block.outputs.length;
    }

    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return block.outputs.length;

    const anchorOutputCount = this.resolveOutputCount(anchorBlock);
    return anchorOutputCount + block.outputs.length - block.claims.length;
  }

  /**
   * Find the chain of blocks from `from` to `to` (exclusive of `from`,
   * inclusive of `to`). Returns blocks in order from `from` toward `to`.
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
      const block = this.store.get(current);
      if (!block) return null;
      const anchor = block.anchor;
      if (Hash.equals(anchor, ZERO_HASH)) return null;
      current = anchor;
      currentKey = current.toPrimitive();
    }

    path.reverse();
    return path;
  }
}

/** BlockCreationModule wired to BlockStore via ProtocolContext. */
export class BlockCreationService extends BlockCreationModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new BlockCreationProviderAdapter(store));
  }
}
