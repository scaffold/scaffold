import { Hash } from './util/Hash.ts';
import { BitVector } from './BitVector.ts';
import { Block, BlockStore } from './Block.ts';
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
    return block.subtreeClaimMask;
  }

  getAggregateOutputCounts(block: Block): number[] {
    return block.aggregateOutputCounts;
  }

  getOwnClaims(block: Block): BitVector {
    return BitVector.fromIndices(
      block.outputCount,
      block.claims,
    );
  }

  getOwnOutputCount(block: Block): number {
    return block.ownOutputCount;
  }

  getOutputCount(block: Block): number {
    return block.outputCount;
  }

  getAnchorOutputCount(block: Block): number {
    return block.anchorOutputCount;
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
