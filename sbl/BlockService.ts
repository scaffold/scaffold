import BlockIngestor from './BlockIngestor.ts';
import { BlockMeta } from './BlockMeta.ts';
import BlockPublisher from './BlockPublisher.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Block } from './messages.ts';
import { bin2hex } from './pathUtils.ts';
import { BlockStore } from './stores.ts';
import Hash from './util/Hash.ts';
import StoreObserver from './util/StoreObserver.ts';
import { trunc } from './util/string.ts';

export default class BlockService {
  constructor(private ctx: Context) {}

  public async ingest(block: Block) {
    console.log(
      `Ingesting block ${block.verifier.contract_hash.toHex()} : ${
        trunc(bin2hex(block.verifier.params), 100)
      } -> ${trunc(bin2hex(block.body), 100)}`,
    );

    const meta: BlockMeta = {
      flags: 0,
      block,
    };
    // const extBlock = Object.assign(block, meta);

    try {
      this.ctx.get(BlockStore).insert(BlockStore.hash(block), block);
      // await this.ctx.get(BlockIngestor).ingest(block);
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
