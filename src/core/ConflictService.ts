import { Hash } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';
import { Block, BlockStore, getAggregationData } from './Block.ts';
import { ConflictModule, ConflictProvider } from './ConflictModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class ConflictProviderAdapter implements ConflictProvider<Block> {
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

  getClaimMask(block: Block): BitVector | null {
    if (block.aggregates.length === 0) return null;
    const aggData = getAggregationData(block);
    return aggData?.claimMask ?? null;
  }

  getAggregateOutputCounts(block: Block): number[] {
    const aggData = getAggregationData(block);
    return aggData?.aggregateOutputCounts ?? [];
  }

  getOwnClaims(block: Block): BitVector {
    const outputCount = this.getOutputCount(block);
    return BitVector.fromIndices(
      outputCount,
      block.claims,
    );
  }

  getOwnOutputCount(block: Block): number {
    return block.outputs.length;
  }

  getOutputCount(block: Block): number {
    const aggData = getAggregationData(block);
    if (aggData) {
      // Total = new outputs + anchor's surviving outputs
      const anchorOutputCount = this.getAnchorOutputCount(block);
      return aggData.newOutputCount + anchorOutputCount - aggData.claimMask.popcount();
    }
    // Leaf block: need anchor's output count to compute
    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return block.outputs.length; // genesis
    const anchorOutputCount = this.getOutputCount(anchorBlock);
    // Leaf: anchorOutputCount - own anchor claims + own outputs
    const ownAnchorClaims = block.claims.filter((c) => c >= block.outputs.length).length;
    return anchorOutputCount - ownAnchorClaims + block.outputs.length -
      block.claims.filter((c) => c < block.outputs.length).length;
  }

  getAnchorOutputCount(block: Block): number {
    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return 0; // genesis
    return this.getOutputCount(anchorBlock);
  }

  getChildren(block: Block): Hash[] {
    return block.aggregates;
  }
}

/** ConflictModule wired to a BlockStore via ProtocolContext. */
export class ConflictService extends ConflictModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new ConflictProviderAdapter(store));
  }
}
