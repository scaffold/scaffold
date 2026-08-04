import { Block, BlockStore } from './Block.ts';
import { getAggregationData } from '../contracts/AggregationContract.ts';
import { Hash } from '../util/Hash.ts';
import { SamplingModule, SamplingProvider } from './SamplingModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class SamplingProviderAdapter implements SamplingProvider<Block> {
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

  // TODO(@joel): aggregateWeights from the aggregation cache stores throughput
  // (per-subtree declared weights), but sample descent should be proportional to
  // verification cost. These are related (effective_weight = verification_cost)
  // but may diverge. Revisit when the aggregation incentive derivation is finalized.
  getAggregateWeights(block: Block): number[] {
    const aggData = getAggregationData(block);
    if (aggData) return aggData.aggregateWeights;
    return [];
  }
}

/** SamplingModule wired to BlockStore via ProtocolContext. */
export class SamplingService extends SamplingModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new SamplingProviderAdapter(store));
  }
}
