import { BlockExt, BlockFlag, BlockMeta } from './BlockMeta.ts';
import BlockPublisher from './BlockPublisher.ts';
import Context from './Context.ts';
import ExecutorLauncherService from './ExecutorLauncherService.ts';
import Logger from './Logger.ts';
import { Block, BlockSet, Verifier } from './messages.ts';
import { bin2hex } from './pathUtils.ts';
import { BlocksByVerifierStore, BlockStore } from './stores.ts';
import { arrEquals } from './util/buffer.ts';
import { error } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { trunc } from './util/string.ts';

export default class BlockService {
  private blocksByHash = new Map<HashPrimitive, BlockExt>();
  private claimsByOutput = new Map<HashPrimitive, BlockExt[]>();
  private onNewBlockListeners = new Map<
    HashPrimitive,
    ((block: BlockExt) => void)[]
  >();
  private onCanonicalBlockListeners = new Map<
    HashPrimitive,
    ((block: BlockExt) => void)[]
  >();
  private onCanonicalBodyListeners = new Map<
    HashPrimitive,
    ((body: Uint8Array) => void)[]
  >();

  constructor(private ctx: Context) {}

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(block: Block) {
    // console.log(
    //   `Ingesting block ${block.verifier.contract_hash.toHex()} : ${
    //     trunc(bin2hex(block.verifier.params), 100)
    //   } -> ${trunc(bin2hex(block.body), 100)}`,
    // );
    // console.log(block);

    const blockHash = BlockStore.hash(block);
    const verifierHash = Hash.digest(Verifier.encode(block.verifier));

    if (this.blocksByHash.has(blockHash.toPrimitive())) {
      return;
    }

    const meta: BlockMeta = {
      hash: blockHash,
      nonce: Math.random(),

      receivedTimestamp: this.ctx.config.timeProvider(),
      flags: BlockFlag.Null,
      derivedWork: 0,
      mergeableProbability: 0,
      outputClaims: block.outputs.map(({ verifier }) =>
        this.getClaims(blockHash, Hash.digest(Verifier.encode(verifier)))
      ),
      propagationMask: 0,

      derivedWorkValue: 0,
      derivedWorkError: Infinity,
      mergeableLogProbabilityValue: 0,
      mergeableLogProbabilityError: 0,

      canonicality: 0,
      collateral: 0,
    };
    const blockExt = Object.assign(block, meta);
    this.blocksByHash.set(blockHash.toPrimitive(), blockExt);

    blockExt.inputs.forEach(({ block_hash }) =>
      this.getClaims(block_hash, verifierHash).push(blockExt)
    );

    block.outputs.forEach(({ verifier }) =>
      this.ctx.get(ExecutorLauncherService).updateGenerator(verifier, 0)
    );

    this.updateDerivedWork(blockExt);

    this.onNewBlockListeners.get(verifierHash.toPrimitive())?.forEach((cb) =>
      cb(blockExt)
    );

    // TODO: Use a simpler store; also update FetchService
    this.ctx.get(BlocksByVerifierStore).mutate(
      verifierHash,
      (blocks) => blocks ? [...blocks, blockExt] : [blockExt],
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

  public updateCanonicality(block: BlockExt, someInputCanonicality?: boolean) {
    // Note that we consider missing inputs as canonical.
    // We also short-circuit if an input canonicality is false, which is a common case.

    const verifierHash = Hash.digest(Verifier.encode(block.verifier));

    const canonicality = block.inputs.reduce((acc, { block_hash }) => {
      const claims = this.getClaims(block_hash, verifierHash);
      const maxCompetitorWork = Math.max(
        ...claims.map((c) => c === block ? 0 : c.derivedWorkValue),
      );
      const delta = block.derivedWorkValue - maxCompetitorWork;
      const inputBlock = this.blocksByHash.get(block_hash.toPrimitive());
      const inputCanonicality = inputBlock === undefined
        ? delta
        : Math.min(delta, inputBlock.canonicality);
      return Math.min(acc, inputCanonicality);
    }, Infinity);

    if (canonicality !== block.canonicality) {
      block.canonicality = canonicality;
      if (canonicality > 0) {
        // this.onCanonicalBlockListeners
      }
      for (const claims of block.outputClaims) {
        // const maxDerivedWork = isCanonical &&
        //   Math.max(...claims.map((c) => c.derivedWorkValue));
        for (const outputBlock of claims) {
          this.updateCanonicality(
            outputBlock,
            // outputBlock.derivedWorkValue === maxDerivedWork,
          );
        }
      }
    }

    for (const { block_hash } of block.inputs) {
      const input = this.blocksByHash.get(block_hash.toPrimitive());
      if (input !== undefined) {
        this.updateCollateral(input);
      }
    }
  }

  public updateCollateral(block: BlockExt) {
    block.collateral = block.outputs.reduce(
      (acc, { amount }, idx) =>
        amount > 0n
          ? Math.max(
            acc,
            Math.min(
              Number(amount),
              block.outputClaims[idx].reduce(
                (acc, claim) => Math.max(acc, claim.canonicality),
                0,
              ),
            ),
          )
          : acc,
      0,
    );
  }

  public updateDerivedWork(block: BlockExt) {
    let sum = Number(this.getWork(block));

    for (const claims of block.outputClaims) {
      for (const outputBlock of claims) {
        if (outputBlock.canonicality > 0) {
          sum += outputBlock.derivedWorkValue /
            outputBlock.inputs.filter(({ block_hash }) =>
              this.blocksByHash.get(block_hash.toPrimitive())
            ).length;
        }
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

    this.updateCanonicality(block);
    this.updateLogMergeableProbability(block);
  }

  public updateLogMergeableProbability(block: BlockExt) {
    // Commented out because I think a canonicality bool is fine

    /*
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
    */
  }

  private getClaims(emitterHash: Hash, verifierHash: Hash) {
    return getOrCreate(
      this.claimsByOutput,
      Hash.composePrimitives(
        emitterHash.toPrimitive(),
        verifierHash.toPrimitive(),
      ),
      () => [],
    );
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

  public onNewBlock(verifier: Verifier, cb: (block: BlockExt) => void) {
    const verifierHash = Hash.digest(Verifier.encode(verifier));
    getOrCreate(this.onNewBlockListeners, verifierHash.toPrimitive(), () => [])
      .push(cb);
  }

  public snapshot() {
    return { blocksByHash: this.blocksByHash };
  }
}
