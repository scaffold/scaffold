import secp from './util/secp.ts';
import BlockBuilder from './BlockBuilder.ts';
import BlockService from './BlockService.ts';
import Context from './Context.ts';
import Logger from './Logger.ts';
import { Block, Verifier } from './messages.ts';
import {
  LaunchableIncentivesStore,
  RequestsByGenerationStore,
  WorkableIncentivesStore,
} from './stores.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import WorkQueueUtil, { WorkFn } from './util/WorkQueue.ts';
import { FulfillmentRegistry } from './registries.ts';
import IncentiveService from './IncentiveService.ts';
import WorkerExecutor from './WorkerExecutor.ts';
import { generatorHash, rootHash, timeHash } from './constants.ts';
import { bin2str } from './pathUtils.ts';
import LocalGeneratorService, {
  LocalGenerator,
} from './LocalGeneratorService.ts';
import { getOrCreate } from './util/map.ts';
import { error } from './util/functional.ts';
import FetchService from './FetchService.ts';

const useLocalExecution = false;
const secret = secp.utils.randomBytes(32);
const dummyWork = async () => {};

const uncomputableContracts = [rootHash, generatorHash];

class NeedsMoreDataError extends Error {
  constructor() {
    super();
  }
}

export default class WorkQueue extends WorkQueueUtil {
  // private attemptDupeFraction = Hash.fromFraction(1, 8);
  private attemptDupeFraction = Hash.fromFraction(0, 8);

  private extraIncentive = new Map<HashPrimitive, number>();

  constructor(private ctx: Context) {
    super();

    ctx.onDestruct(() => this.setWorkerCount(0));

    const idx = setInterval(() => this.cleanup(), 1000);
    ctx.onDestruct(() => clearInterval(idx));

    this.setWorkerCount(ctx.config.initialWorkerCount);

    // // Requires generators
    // ctx.get(WorkableIncentivesStore).onMutate((hash, _, work) => {
    //   console.log('RUN MUT', hash.toHex(), work?.verifier.params, work?.amount);

    //   if (work !== undefined) {
    //     if (work.amount > 0n) {
    //       throw new Error(`Invalid amount`);
    //     }

    //     this.set(
    //       hash,
    //       -Number(work.amount),
    //       () => this.run(work.generator.body, work.verifier, work.amount),
    //     );
    //   } else {
    //     this.set(hash, 0, dummyWork);
    //   }
    // });

    // Doesn't need generators
    // ctx.get(LaunchableIncentivesStore).onMutate((hash, _, work) => {
    //   if (
    //     work &&
    //     uncomputableContracts.some((uc) =>
    //       Hash.equals(work.verifier.contract_hash, uc)
    //     )
    //   ) {
    //     return;
    //   }

    //   console.log(
    //     'RUN MUT',
    //     hash.toHex(),
    //     work?.verifier.contract_hash.toHex(),
    //     work?.verifier.params,
    //     work?.amount,
    //   );

    //   if (work !== undefined) {
    //     if (work.amount > 0n) {
    //       throw new Error(`Invalid amount`);
    //     }

    //     this.set(
    //       hash,
    //       -Number(work.amount),
    //       () => this.run(work.verifier, work.amount),
    //     );
    //   } else {
    //     this.set(hash, 0, dummyWork);
    //   }
    // });
  }

  private shouldEmitCorrect(verifier: Verifier) {
    return Hash.cmp(
      Hash.digest(
        arrConcat(secret, verifier.contract_hash.toBytes(), verifier.params),
      ),
      this.attemptDupeFraction,
    ) === 1;
  }

  private makeWorker(verifier: Verifier): WorkFn | undefined {
    const onDone = (data: Uint8Array, inputs: Block[], durationMs: number) => {
      console.log('Completed generator', verifier, bin2str(data));
      const block = this.ctx.get(BlockBuilder).build(verifier, data);
      this.ctx.get(BlockService).ingest(block);
      // answer.difficultyEstimate = BigInt(durationMs) *
      //   this.ctx.config.approxComputePricePerSecond / 1000n;
    };

    const localGenerator = this.ctx.get(LocalGeneratorService).getGenerator(
      verifier.contract_hash,
    );
    if (localGenerator) {
      return async (_pause, _resume) => {
        const body = await localGenerator({
          ctx: this.ctx,
          contractHash: verifier.contract_hash,
          params: verifier.params,
          emitCorrect: this.shouldEmitCorrect(verifier),
          setFreeMarket: () => error('Not implemented'),
          request: (contractHash: Hash, params: Uint8Array) =>
            new Promise((resolve) =>
              // TODO: Call pause/resume when requesting?
              this.ctx.get(FetchService).fetch(
                { contract_hash: contractHash, params },
                {},
                // TODO: Handle dirty inputs (repeated resolve calls)
                (block) => resolve(block.body),
              )
            ),
          notify: (contractHash: Hash, params: Uint8Array) =>
            this.ctx.get(FetchService).fetch({
              contract_hash: contractHash,
              params,
            }, {}),
        });
        onDone(body, [], 0);
      };
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contract_hash: generatorHash,
        params: verifier.contract_hash.toBytes(),
      });
      if (generatorBlocks.length) {
        return async (_pause, _resume) => {
          const generatorData = generatorBlocks[0].body;
          const { cancel, result, hasDirtyInputs } = this.ctx.get(
            WorkerExecutor,
          ).run(
            // {
            //   contract_hash: generatorHash,
            //   params: verifier.contract_hash.toBytes(),
            // }
            generatorData,
            {
              contractHash: verifier.contract_hash.toBytes(),
              params: verifier.params,
              emitCorrect: new Uint8Array([
                this.shouldEmitCorrect(verifier) ? 1 : 0,
              ]),
              stdin: new Uint8Array([]),
            },
            { stdout: null, stderr: null },
          );
          result.then((out) => console.log('DONE', out));
          result.then(({ outputs: { stdout, stderr }, usedBlocks }) => {
            console.log('STDOUT', bin2str(stdout));
            console.log('STDERR', bin2str(stderr));

            onDone(stdout, [...usedBlocks], 0);
            hasDirtyInputs.then(() => console.error(`Dirty inputs!`));
          });
          await result;
        };
      }
    }
  }

  public addExtraIncentive(verifier: Verifier, inc: number) {
    const hash = Hash.digest(Verifier.encode(verifier));
    getOrCreate(
      this.extraIncentive,
      hash.toPrimitive(),
      () => inc,
      (x) => x + inc,
    );

    const entry = this.get(hash);
    if (entry) {
      this.set(hash, entry.valuePerSecond + inc, entry.work);
    } else {
      const worker = this.makeWorker(verifier);
      if (worker) {
        this.set(hash, inc, worker);
      }
    }
  }

  public update(verifier: Verifier) {
    const worker = this.makeWorker(verifier);
    if (worker) {
      const hash = Hash.digest(Verifier.encode(verifier));
      const score = this.ctx.get(BlockService).getBlocksByOutput(verifier)
        .reduce((acc, block) => {
          const idx = block.outputs.findIndex((o) =>
            Hash.equals(o.verifier.contract_hash, verifier.contract_hash) &&
            arrEquals(o.verifier.params, verifier.params)
          );
          if (idx === -1) {
            throw new Error(`Internal error`);
          }
          const { amount } = block.outputs[idx];
          const claims = block.outputClaims[idx];
          return claims.length ? acc : acc +
            Math.exp(block.mergeableLogProbabilityValue) * Number(amount);
        }, this.extraIncentive.get(hash.toPrimitive()) || 0);
      this.set(hash, score, worker);
    }
  }

  private async callWithSyncRequestHandler<T>(
    verifier: Verifier,
    func: (
      handler: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notifier: (contractHash: Hash, params: Uint8Array) => void,
    ) => T | Promise<T>,
    incentive: bigint,
    generationHash: Hash,
    onDone: (answer: T, inputs: Block[], durationMs: number) => void,
  ) {
    const requests: Verifier[] = [];

    try {
      const inputs: Block[] = [];
      const startTime = Date.now();
      const out = await func((contractHash: Hash, params: Uint8Array) => {
        const innerVerifier = { contract_hash: contractHash, params };
        const verifierHash = Hash.digest(Verifier.encode(innerVerifier));
        const blocks = this.ctx.get(FulfillmentRegistry).getOrWait(
          verifierHash,
        );
        if (blocks instanceof Promise) {
          requests.push(innerVerifier);

          // this.ctx.get(IncentiveService).incentivize(
          //   innerVerifier,
          //   incentive / 2n,
          // );

          // this.ctx.get(NodeService).getAll().forEach((node) =>
          //   node.defaultConn?.sendReliable({
          //     BidMessage: { verifier: innerVerifier, output: verifier },
          //   })
          // );

          blocks.then(() =>
            this.callWithSyncRequestHandler(
              verifier,
              func,
              incentive,
              generationHash,
              onDone,
            )
          );
          throw new NeedsMoreDataError();
        } else {
          const block = blocks[0];
          inputs.push(block);
          return block.body;
        }
      }, (contractHash: Hash, params: Uint8Array) => {
        const innerVerifier = { contract_hash: contractHash, params };
        const verifierHash = Hash.digest(Verifier.encode(verifier));
        const blocks = this.ctx.get(FulfillmentRegistry).get(verifierHash);
        if (!blocks) {
          requests.push(innerVerifier);

          // this.ctx.get(IncentiveService).incentivize(
          //   innerVerifier,
          //   incentive / 2n,
          // );

          // this.ctx.get(NodeService).getAll().forEach((node) =>
          //   node.defaultConn?.sendReliable({
          //     BidMessage: { verifier: innerVerifier, output: verifier },
          //   })
          // );
        }
      });

      onDone(out, inputs, Date.now() - startTime);
      // this.ctx.get(RequestsByGenerationStore).set(generationHash, undefined);
      this.ctx.get(RequestsByGenerationStore).update(generationHash, 0n, []);
    } catch (err) {
      if (err instanceof NeedsMoreDataError) {
        // Needs more data. Just wait for it.
        // this.ctx.get(RequestsByGenerationStore).set(generationHash, {
        //   incentive: incentive < -1n ? incentive + 1n : 0n,
        //   requests,
        // });
        this.ctx.get(RequestsByGenerationStore).update(
          generationHash,
          incentive < -1n ? incentive + 1n : 0n,
          requests,
        );
      } else {
        throw err;
      }
    }
  }
}
