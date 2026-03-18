import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, getAggregationData } from './Block.ts';
import { OutputClaimModule, OutputClaimProvider } from './OutputClaimModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class OutputClaimProviderAdapter implements OutputClaimProvider<Block> {
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

  getOwnOutputCount(block: Block): number {
    return block.outputs.length;
  }

  getAggregateHashes(block: Block): Hash[] {
    return block.aggregates;
  }

  getAggregateOutputCounts(block: Block): number[] {
    const aggData = getAggregationData(block);
    return aggData?.aggregateOutputCounts ?? [];
  }
}

/** OutputClaimModule wired to a BlockStore via ProtocolContext. */
export class OutputClaimService extends OutputClaimModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new OutputClaimProviderAdapter(store));
  }
}
