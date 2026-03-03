import { Hash } from '../util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { ConsensusModule, ConsensusProvider } from './ConsensusModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class ConsensusProviderAdapter implements ConsensusProvider<Block> {
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

  getAggregates(block: Block): Hash[] {
    return block.aggregates;
  }

  getWeightVector(block: Block): number[] {
    return block.weightVector;
  }
}

/** ConsensusModule wired to a BlockStore via ProtocolContext. */
export class ConsensusService extends ConsensusModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new ConsensusProviderAdapter(store));
  }
}
