import { Hash } from './util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { SamplingModule, SamplingProvider } from './SamplingModule.ts';
import { ConsensusService } from './ConsensusService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class SamplingProviderAdapter implements SamplingProvider<Block> {
  constructor(
    private readonly store: BlockStore,
    private readonly consensus: ConsensusService,
  ) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getDeclaredWork(block: Block): number {
    return block.declaredWeight;
  }

  getDescendantWeight(block: Block): number {
    return this.consensus.getDescendantWeight(block.hash);
  }
}

/** SamplingModule wired to BlockStore and ConsensusService via ProtocolContext. */
export class SamplingService extends SamplingModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const consensus = ctx.get(ConsensusService);
    super(new SamplingProviderAdapter(store, consensus));
  }
}
