import BlockIngestor from './BlockIngestor.ts';
import { BlockExt, BlockMeta } from './BlockMeta.ts';
import BlockPublisher from './BlockPublisher.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Block, BlockSet, Verifier } from './messages.ts';
import { bin2hex } from './pathUtils.ts';
import { BlocksByVerifierStore, BlockStore } from './stores.ts';
import { arrEquals } from './util/buffer.ts';
import { error } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import StoreObserver from './util/StoreObserver.ts';
import { trunc } from './util/string.ts';
import PoissonDistribution from './util/PoissonDistribution.ts';
import DerivedWorkService from './DerivedWorkService.ts';
import WorkQueue from './WorkQueue.ts';

export default class BlockService {
  private blocksByHash = new Map<HashPrimitive, BlockExt>();
  private listenersByVerifier = new Map<HashPrimitive, (() => void)[]>();

  constructor(private ctx: Context) {}

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(block: Block) {
    console.log(
      `Ingesting block ${block.verifier.contract_hash.toHex()} : ${
        trunc(bin2hex(block.verifier.params), 100)
      } -> ${trunc(bin2hex(block.body), 100)}`,
    );
    console.log(block);

    const hash = BlockStore.hash(block);
    const blockExt = getOrCreate(
      this.blocksByHash,
      hash.toPrimitive(),
      () => {
        const meta: BlockMeta = {
          nonce: Math.random(),
          receivedTimestamp: this.ctx.config.timeProvider(),
          flags: 0,
          derivedWork: 0,
          mergeableProbability: 0,
          outputClaims: block.outputs.map(({ verifier, amount }) =>
            this.getBlocksByOutput(verifier).filter((x) =>
              x.inputs.some((i) =>
                Hash.equals(i.block_hash, hash) && i.amount === amount
              )
            )
          ),
          propagationMask: 0,

          derivedWorkValue: 0,
          derivedWorkError: Infinity,
          mergeableLogProbabilityValue: 0,
          mergeableLogProbabilityError: 0,
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
      }
    });

    this.updateDerivedWork(blockExt);

    // TODO: Use a simpler store; also update FetchService
    this.ctx.get(BlocksByVerifierStore).mutate(
      Hash.digest(Verifier.encode(block.verifier)),
      (blocks) => blocks ? [...blocks, block] : [block],
    );

    // const samples = PoissonDistribution.sample(
    //   Number(this.getWork(blockExt)) * this.getSamplesPerWork(),
    // );
    // if (samples > 0) {
    //   this.ctx.get(DerivedWorkService).addSample(blockExt);
    // }

    // try {
    //   this.ctx.get(BlockStore).insert(BlockStore.hash(block), block);
    //   // await this.ctx.get(BlockIngestor).ingest(block);
    // } catch (err) {
    //   console.error(
    //     'Error ingesting block',
    //     this.ctx.get(Logger).serialize(block),
    //     ':',
    //     err,
    //   );
    //   return;
    // }

    // console.log('Publishing block...', this.ctx.get(Logger).serialize(block));

    this.ctx.get(BlockPublisher).publish(block);
  }

  public updateDerivedWork(block: BlockExt) {
    let sum = Number(this.getWork(block));

    for (const claims of block.outputClaims) {
      for (const outputBlock of claims) {
        sum += outputBlock.derivedWorkValue /
          outputBlock.inputs.filter(({ block_hash }) =>
            this.blocksByHash.get(block_hash.toPrimitive())
          ).length;
      }
    }

    const err = Math.abs(sum - block.derivedWorkValue);
    if (err > block.derivedWorkError) {
      console.error(
        `Actual derived work error (${err}) is greater than the computed error (${block.derivedWorkError})! `,
      );
    }

    block.derivedWorkValue = sum;
    block.derivedWorkError = 0;

    const knownInputs = block.inputs
      .map(({ block_hash }) => this.blocksByHash.get(block_hash.toPrimitive()))
      .filter(Boolean);
    const errInc = err / knownInputs.length;
    for (const input of knownInputs) {
      input!.derivedWorkError += errInc;
      if (input!.derivedWorkError > input!.derivedWorkValue * 0.1) {
        this.updateDerivedWork(input!);
      }
    }

    for (const claims of block.outputClaims) {
      for (const outputBlock of claims) {
        this.updateLogMergeableProbability(outputBlock);
      }
    }

    this.updateLogMergeableProbability(block);
  }

  public updateLogMergeableProbability(block: BlockExt) {
    let sum = 0;
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
            `Invalid input Block doesn't output to this verifier with amount ${amount}`,
          );
        }

        const claims = inBlock.outputClaims[idx];
        const total = claims.reduce(
          (acc, cur) => acc + cur.derivedWorkValue,
          0,
        );
        sum += Math.log(block.derivedWorkValue / total);
        sum += inBlock.mergeableLogProbabilityValue /
          inBlock.outputClaims.filter((claims) => claims.length).length;
      }
    }

    const err = Math.abs(sum - block.mergeableLogProbabilityValue);
    if (err > block.mergeableLogProbabilityError) {
      console.error(
        `Actual log mergeable probability error (${err}) is greater than the computed error (${block.mergeableLogProbabilityError})! `,
      );
    }

    block.mergeableLogProbabilityValue = sum;
    block.mergeableLogProbabilityError = 0;

    const errInc = err /
      block.outputClaims.filter((claims) => claims.length).length;
    if (block.outputClaims.length !== block.outputs.length) {
      throw new Error(`Internal error`);
    }
    for (let i = 0; i < block.outputClaims.length; i++) {
      const output = block.outputs[i];
      const claims = block.outputClaims[i];
      for (const outputBlock of claims) {
        outputBlock.mergeableLogProbabilityError += errInc;
        if (
          outputBlock.mergeableLogProbabilityError >
            outputBlock.mergeableLogProbabilityValue * 0.1
        ) {
          this.updateLogMergeableProbability(outputBlock);
        }
      }
      this.ctx.get(WorkQueue).update(output.verifier);
    }
  }

  public getWork(block: Block | BlockSet) {
    return block.outputs.reduce((acc, { amount }) => acc - amount, 1n);
  }

  private getSamplesPerWork() {
    return 0.1;
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

    return this.blocksByHash.get(hash.toPrimitive());

    // return new Promise<Block>((resolve) => {
    //   const observer = StoreObserver.get(this.ctx.get(BlockStore));
    //   const cb = (block: Block | undefined) => {
    //     observer.unobserve(hash, cb);
    //     resolve(block!);
    //   };
    //   observer.observe(hash, cb);
    // });
  }

  public getBlocksByVerifier(verifier: Verifier) {
    return [...this.blocksByHash.values()].filter((x) =>
      Hash.equals(x.verifier.contract_hash, verifier.contract_hash) &&
      arrEquals(x.verifier.params, verifier.params)
    );
  }

  public getBlocksByOutput(verifier: Verifier) {
    return [...this.blocksByHash.values()].filter((x) =>
      x.outputs.some((y) =>
        Hash.equals(y.verifier.contract_hash, verifier.contract_hash) &&
        arrEquals(y.verifier.params, verifier.params)
      )
    );
  }

  public snapshot() {
    return { blocksByHash: this.blocksByHash };
  }
}
