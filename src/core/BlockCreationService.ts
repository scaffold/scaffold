import { Hash } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';
import {
  Block,
  BlockStore,
  getAggregationData,
  getBlockWeightVector,
} from './Block.ts';
import { BlockCreationModule, BlockCreationProvider } from './BlockCreationModule.ts';
import { ConflictService } from './ConflictService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class BlockCreationProviderAdapter implements BlockCreationProvider<Block> {
  constructor(
    private readonly store: BlockStore,
    private readonly conflict: ConflictService,
  ) {}

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
    const aggData = getAggregationData(block);
    if (aggData) {
      // Total output space = new outputs from subtree + anchor's surviving outputs
      const anchorOutputCount = this.getAnchorOutputCount(block);
      return aggData.newOutputCount + anchorOutputCount - aggData.claimMask.length;
    }
    // Leaf: anchor outputs - own anchor claims + own outputs
    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return block.outputs.length; // genesis
    const anchorOutputCount = this.getOutputCount(anchorBlock);
    const ownAnchorClaims = block.claims.filter((c) => c >= block.outputs.length).length;
    return anchorOutputCount - ownAnchorClaims + block.outputs.length -
      block.claims.filter((c) => c < block.outputs.length).length;
  }

  private getAnchorOutputCount(block: Block): number {
    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return 0;
    return this.getOutputCount(anchorBlock);
  }

  getWeightVector(block: Block): number[] {
    return getBlockWeightVector(block);
  }

  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined {
    return this.store.getAnchorDepth(from, ancestor);
  }

  getRebasedClaimMask(blockHash: Hash, targetAnchor: Hash): BitVector | null {
    const result = this.conflict.rebase(blockHash, targetAnchor);
    if (!result) return null;
    return result.mask;
  }
}

/** BlockCreationModule wired to BlockStore and ConflictService via ProtocolContext. */
export class BlockCreationService extends BlockCreationModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const conflict = ctx.get(ConflictService);
    super(new BlockCreationProviderAdapter(store, conflict));
  }
}
