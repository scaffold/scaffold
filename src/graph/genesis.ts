import { AtomSource, Block } from './types.ts';
import { Context } from '../Context.ts';
import { BlockStore } from './BlockStore.ts';

export class Genesis {
  private genesis: Block;

  constructor(ctx: Context) {
    this.genesis = ctx.get(BlockStore).ingest({
      source: AtomSource.Genesis,
      receivedAt: ctx.config.timeProvider.nowMs(),
      raw: ctx.config.genesis,
    });
  }

  getGenesis(): Block {
    return this.genesis;
  }
}
