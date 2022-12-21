import BlockIngestor from './BlockIngestor.ts';
import { BlockMeta } from './BlockMeta.ts';
import BlockPublisher from './BlockPublisher.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Block } from './messages.ts';
import { BlockStore } from './stores.ts';
import Hash from './util/Hash.ts';
import StoreObserver from './util/StoreObserver.ts';

export default class BlockService {
  constructor(private ctx: Context) {}

  public async ingest(block: Block) {
    const meta: BlockMeta = {
      flags: 0,
      block,
    };
    // const extBlock = Object.assign(block, meta);

    const blockHash = Hash.digest(Block.encode(block));
    this.ctx.get(BlockStore).insert(blockHash, block);

    try {
      await this.ctx.get(BlockIngestor).ingest(block);
    } catch (err) {
      console.error(
        'Error ingesting block',
        this.ctx.get(Logger).serialize(block),
        ':',
        err,
      );
      return;
    }

    console.log('Publishing block...', this.ctx.get(Logger).serialize(block));

    this.ctx.get(BlockPublisher).publish(block);
  }

  public get(hash: Hash) {
    // TODO: Incentivize network as well

    return new Promise<Block>((resolve) => {
      const observer = StoreObserver.get(this.ctx.get(BlockStore));
      const cb = (block: Block | undefined) => {
        observer.unobserve(hash, cb);
        resolve(block!);
      };
      observer.observe(hash, cb);
    });
  }
}
