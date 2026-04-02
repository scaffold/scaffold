import { Hash } from '../util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { ProbeModule, ProbeProvider } from './ProbeModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class ProbeProviderAdapter implements ProbeProvider<Block> {
  constructor(
    private readonly store: BlockStore,
  ) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getHash(block: Block): Hash {
    return block.hash;
  }

  getAggregates(block: Block): Hash[] {
    return block.aggregates;
  }

  getSelfWeight(block: Block): number {
    return block.selfWeight ?? block.declaredWeight;
  }

  getAggregateWeights(block: Block): number[] {
    return block.aggregates.map((aggHash) => {
      const agg = this.store.get(aggHash);
      return agg ? (agg.subtreeWeight ?? agg.declaredWeight) : 0;
    });
  }
}

/** ProbeModule wired to BlockStore via ProtocolContext. */
export class ProbeService extends ProbeModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new ProbeProviderAdapter(store));
  }
}
