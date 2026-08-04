import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, getBlockTotalWeightVector } from './Block.ts';
import { getAggregationData } from '../contracts/AggregationContract.ts';
import { BlockCreationModule, BlockCreationProvider } from './BlockCreationModule.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from './OutputSpace.ts';
import { ProtocolContext } from './ProtocolContext.ts';

/** Create an OutputSpaceProvider backed by a BlockStore. */
function makeOutputSpaceProvider(store: BlockStore): OutputSpaceProvider {
  return {
    getBlock(hash: Hash): OutputSpaceBlock | undefined {
      const block = store.get(hash);
      if (!block) return undefined;
      const aggData = getAggregationData(block);
      const sc = block.claimIndices.filter((c) => c < block.outputs.length).length;
      return {
        hash: block.hash,
        anchor: block.anchor,
        aggregates: block.aggregates,
        outputs: block.outputs.map((o) => ({ value: o.value })),
        claimIndices: block.claimIndices,
        aggregateOutputCounts: aggData?.aggregateOutputCounts ?? [],
        newOutputCount: aggData?.newOutputCount ?? (block.outputs.length - sc),
      };
    },
  };
}

class BlockCreationProviderAdapter implements BlockCreationProvider<Block> {
  private readonly outputSpace: OutputSpaceModule;

  constructor(
    private readonly store: BlockStore,
  ) {
    this.outputSpace = new OutputSpaceModule(makeOutputSpaceProvider(store));
  }

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
    const ownAnchorClaims = block.claimIndices.filter((c) => c >= block.outputs.length).length;
    return anchorOutputCount - ownAnchorClaims + block.outputs.length -
      block.claimIndices.filter((c) => c < block.outputs.length).length;
  }

  private getAnchorOutputCount(block: Block): number {
    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return 0;
    return this.getOutputCount(anchorBlock);
  }

  getWeightVector(block: Block): number[] {
    return getBlockTotalWeightVector(block);
  }

  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined {
    return this.store.getAnchorDepth(from, ancestor);
  }

  getRebasedClaimMask(blockHash: Hash, targetAnchor: Hash): readonly number[] | null {
    return this.outputSpace.rebaseClaimMask(blockHash, targetAnchor);
  }

  getRebasedClaimMaskExclusive(blockHash: Hash, targetAnchor: Hash): readonly number[] | null {
    return this.outputSpace.rebaseClaimMaskExclusive(blockHash, targetAnchor);
  }
}

/** BlockCreationModule wired to BlockStore via ProtocolContext. */
export class BlockCreationService extends BlockCreationModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new BlockCreationProviderAdapter(store));
  }
}
