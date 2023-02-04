import BlockIngestor from './BlockIngestor.ts';
import { BlockExt, BlockMeta } from './BlockMeta.ts';
import BlockPublisher from './BlockPublisher.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Block, Verifier } from './messages.ts';
import { bin2hex } from './pathUtils.ts';
import { BlockStore } from './stores.ts';
import { arrEquals } from './util/buffer.ts';
import { error } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import StoreObserver from './util/StoreObserver.ts';
import { trunc } from './util/string.ts';

export default class BlockService {
  private blocksByHash: Map<HashPrimitive, BlockExt> = new Map();

  constructor(private ctx: Context) {}

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(block: Block) {
    console.log(
      `Ingesting block ${block.verifier.contract_hash.toHex()} : ${
        trunc(bin2hex(block.verifier.params), 100)
      } -> ${trunc(bin2hex(block.body), 100)}`,
    );

    const hash = BlockStore.hash(block);
    const blockExt = getOrCreate(
      this.blocksByHash,
      hash.toPrimitive(),
      () => {
        const meta: BlockMeta = {
          receivedTimestamp: this.ctx.config.timeProvider(),
          flags: 0,
          derivedWork: 1,
          mergeableProbability: 0,
          outputClaims: block.outputs.map(({ verifier, amount }) =>
            [...this.blocksByHash.values()].filter((x) =>
              Hash.equals(x.verifier.contract_hash, verifier.contract_hash) &&
              arrEquals(x.verifier.params, verifier.params) &&
              x.inputs.some((i) =>
                Hash.equals(i.block_hash, hash) && i.amount === amount
              )
            )
          ),
        };
        return Object.assign(block, meta);
      },
      () => error(`Duplicate block`),
    );

    blockExt.inputs.forEach(({ block_hash, amount }) => {
      const inBlock = this.blocksByHash.get(block_hash.toPrimitive());
      if (inBlock) {
        const idx = inBlock.outputs.findIndex((o) =>
          Hash.equals(
            o.verifier.contract_hash,
            blockExt.verifier.contract_hash,
          ) && arrEquals(o.verifier.params, blockExt.verifier.params) &&
          o.amount === amount
        );
        if (idx === -1) {
          throw new Error(
            `Invalid input! Block doesn't output to this verifier with amount ${amount}`,
          );
        }

        inBlock.outputClaims[idx].push(blockExt);
        inBlock.derivedWork = this.calculateDerivedWork(inBlock);
      }
    });

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

  private calculateMergeableProbability(block: BlockExt) {
    let prob = 1;
    for (const { block_hash, amount } of block.inputs) {
      const inBlock = this.blocksByHash.get(block_hash.toPrimitive());
      if (inBlock) {
        const idx = inBlock.outputs.findIndex((o) =>
          Hash.equals(
            o.verifier.contract_hash,
            block.verifier.contract_hash,
          ) && arrEquals(o.verifier.params, block.verifier.params) &&
          o.amount === amount
        );
        if (idx === -1) {
          throw new Error(
            `Invalid input! Block doesn't output to this verifier with amount ${amount}`,
          );
        }

        const claims = inBlock.outputClaims[idx];
        const total = claims.reduce((acc, cur) => acc + cur.derivedWork, 0);
        prob *= block.derivedWork / total;
      }
    }
    return prob;
  }

  private calculateDerivedWork(block: BlockExt) {
    let res = 0;
    for (const output of block.outputClaims) {
      for (const claim of output) {
        res += claim.derivedWork * claim.mergeableProbability;
      }
    }
    return res;
    // return BigInt(res) - BigInt(block.receivedTimestamp);
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

  public snapshot() {
    return { blocksByHash: this.blocksByHash };
  }
}
