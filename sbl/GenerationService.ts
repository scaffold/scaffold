import BlockBuilder, { BlockSpec, InputSpec } from '~/sbl/BlockBuilder.ts';
import BlockService from './BlockService.ts';
import {
  accountHash,
  frontierHash,
  generatorHash,
  rootHash,
} from './constants.ts';
import Context from './Context.ts';
import WorkerDriverService, { WorkerDriver } from './WorkerDriverService.ts';
import LocalGeneratorService from './LocalGeneratorService.ts';
import { Block, BlockOutput, Verifier } from './messages.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { todo } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import WorkerExecutor from './WorkerExecutor.ts';
import LitigationService from './LitigationService.ts';
import Logger from './Logger.ts';
import { BlockFact, FactSource, FactType } from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import ClockService from '~/sbl/ClockService.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import FetchService from '~/sbl/FetchService.ts';
import UnclaimedOutputService from '~/sbl/UnclaimedOutputService.ts';
import KeyService from '~/sbl/KeyService.ts';
import { bin2hex } from '~/sbl/util/hex.ts';
import ContractClassifierService from '~/sbl/ContractClassifierService.ts';
import { CollateralHint } from '~/sbl/collateralMessages.ts';
import {
  ComputationDriver,
  ComputationType,
  COMPUTE_GENERABLE_FLAG,
  COMPUTE_INGENERABLE_FLAG,
} from '~/sbl/ComputationMeta.ts';
import VerificationService from '~/sbl/VerificationService.ts';

// TODO: Collect all inputs by verifier in here, and getInputSource() should return from here
interface RunningGeneration {
  extraIncentive: number;
}

export default class GenerationService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);
  private secret: Uint8Array;

  private running = new Map<HashPrimitive, RunningGeneration>();

  constructor(private ctx: Context) {
    this.secret = ctx.config.entropyProvider.randomBytes(32);
  }

  public enqueueGeneration(
    verifier: Verifier,
    detail: Uint8Array | undefined,
    extraIncentive: number,
  ) {
    // Fast-path exit for some common cases here:
    if (Hash.equals(verifier.contract_hash, accountHash)) {
      return;
    }

    const runHash = Hash.digest(Verifier.encode(verifier));
    if (this.running.has(runHash.toPrimitive())) {
      this.running.set(runHash.toPrimitive(), { extraIncentive });
      return;
    } else {
      this.running.set(runHash.toPrimitive(), { extraIncentive });
    }

    const special = this.getGenerator(verifier.contract_hash);
    if (special) {
      this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeGenerationDriver(verifier, workerDriver);
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting special generator for ${verifier.contract_hash.toHex()}:${
                bin2hex(verifier.params)
              }`,
          });
          try {
            await special.compute(driver, this.ctx);
            await driver.finalize(COMPUTE_GENERABLE_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        () => this.running.get(runHash.toPrimitive())!.extraIncentive,
      ).then(() => this.running.delete(runHash.toPrimitive()));
      return;
    }

    const getScore = () =>
      this.ctx.get(BlockService).getBlocksByOutput(verifier)
        .reduce((acc, { block, idx }) => {
          const { amount } = block.outputs[idx];
          const claims = block.outputClaims[idx];
          return claims.length === 0 && block.canonicalityOld > 0
            ? acc + /* Math.exp(block.mergeableLogProbabilityValue) * */
              Number(amount)
            : acc;
        }, this.running.get(runHash.toPrimitive())!.extraIncentive);

    const localGenerator = this.ctx.get(LocalGeneratorService)
      .getGenerator(verifier.contract_hash);
    if (localGenerator) {
      this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeGenerationDriver(verifier, workerDriver);
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting local generator for ${verifier.contract_hash.toHex()}:${
                bin2hex(verifier.params)
              }`,
          });
          try {
            await localGenerator(driver, this.ctx);
            await driver.finalize(COMPUTE_GENERABLE_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        getScore,
      ).then(() => this.running.delete(runHash.toPrimitive()));
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contract_hash: generatorHash,
        params: verifier.contract_hash.toBytes(),
      });
      if (generatorBlocks.length) {
        const generatorCode = generatorBlocks[0].body;

        this.ctx.get(WorkerDriverService).run(
          async (workerDriver) => {
            await workerDriver.setAllocation({ webWorkerCount: 1 });
            const driver = this.makeGenerationDriver(verifier, workerDriver);
            workerDriver.log?.push({
              timestamp: this.ctx.config.timeProvider.now(),
              message:
                `Starting worker generator for ${verifier.contract_hash.toHex()}:${
                  bin2hex(verifier.params)
                }`,
            });
            try {
              await this.ctx.get(WorkerExecutor).run(
                {
                  code: generatorCode,
                  // contractHash: verifier.contract_hash.toBytes(),
                  // params: verifier.params,
                  // emitCorrect: this.shouldEmitCorrect(verifier),
                },
                driver,
              );
              await driver.finalize(COMPUTE_GENERABLE_FLAG);
            } catch (err) {
              await driver.finalize(err);
            }
          },
          getScore,
        ).then(() => this.running.delete(runHash.toPrimitive()));
      }
    }
  }

  private getGenerator(contractHash: Hash) {
    for (const provider of this.ctx.config.contractProviders) {
      if (Hash.equals(provider.contractHash, contractHash)) {
        return provider;
      }
    }
  }

  private makeGenerationDriver(
    verifier: Verifier,
    workerDriver: WorkerDriver,
  ): ComputationDriver & { finalize(err: unknown): MaybePromise<void> } {
    let emitCorrect: boolean | undefined;

    let body: Uint8Array | undefined;
    const verifierInputs: InputSpec[] = [];
    const otherInputs: InputSpec[] = [];
    let inputsAreFixed = false;
    const refs: BlockFact[] = [];
    // const satisfies:Verifier=[];
    const outputs: BlockOutput[] = [];
    let frontierLevel: number | undefined;
    let timestampGte: bigint | undefined;

    return {
      ...workerDriver,

      type: ComputationType.Generator,

      getContractHash: () => verifier.contract_hash,
      getParams: () => verifier.params,
      getHint: () => {
        throw new Error(`Cannot call getHint() inside a generator!`);
      },
      getBody: () => {
        throw new Error(`Cannot call getBody() inside a generator!`);
      },
      requireBody: (data) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        if (body === undefined) {
          body = data;
        } else {
          if (!arrEquals(body, data)) {
            // Ingenerable
            throw COMPUTE_INGENERABLE_FLAG;
          }
        }
      },
      requireOutput: (output: BlockOutput) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        outputs.push(output);
      },
      requireTimestampGte: (timestamp: bigint) => {
        if (timestampGte === undefined || timestamp > timestampGte) {
          timestampGte = timestamp;
        }
      },
      requireSignature: (publicKey) => {
        // TODO: If we don't call this, maybe we don't necessarily need to sign the block?
        const selfPublicKey = this.ctx.get(KeyService).getSelfPublicKey();
        if (!arrEquals(publicKey, selfPublicKey)) {
          throw COMPUTE_INGENERABLE_FLAG;
        }
      },
      emitCorrect: () => {
        if (emitCorrect === undefined) {
          emitCorrect = this.shouldEmitCorrect(verifier);
        }
        return emitCorrect;
      },

      notify: (contractHash, params) => {
        this.ctx.get(FetchService).fetch(
          { contract_hash: contractHash, params },
          { abortSignal: workerDriver.done.signal },
        );
      },
      request: (contractHash, params) =>
        new Promise((reply) => {
          if (workerDriver.done.signal.aborted) {
            return;
          }

          workerDriver.pauseTimer(
            `request(${contractHash.toHex()}, ${bin2hex(params)})`,
          );

          const verifier = { contract_hash: contractHash, params };

          // TODO: Call pause/resume when requesting?
          this.ctx.get(FetchService).fetch(
            verifier,
            { abortSignal: workerDriver.done.signal },
            (block) => {
              this.ctx.get(Logger).info('got req', { verifier, block });

              // TODO: If we get a non-canonical block (canonicality <= 0), we have to check if it's mergeable with the other inputs (positive and negative).
              // If it's not, or maybe just in any case of not having a canonical input:
              //   Any block can be made canonical by re-writing, and not claiming the disputed input(s).

              // TODO: Handle multiple resolutions, with blocks with the same and varying bodies.
              // TODO: Handle case when we already have a ref fulfilling the verifier.
              // TODO: Handle case when that ref gets replaced and no longer fulfills the verifier.

              refs.push(block);
              workerDriver.resumeTimer();
              reply(block.body);
            },
          );
        }),

      fulfills: (block: BlockFact, outputIdx: number) =>
        otherInputs.push({
          block,
          outputIdx,
          amount: block.outputs[outputIdx].amount,
        }),

      getInputCount: () => {
        if (!inputsAreFixed) {
          this.ctx.get(BlockBuilder).collectInputs(
            verifierInputs,
            verifier,
            false,
          );
          inputsAreFixed = true;
        }
        return verifierInputs.length;
      },
      getInputSource: async (idx: number) => {
        workerDriver.pauseTimer(`getInputSource(${idx})`);

        let input: InputSpec;
        if (inputsAreFixed) {
          input = verifierInputs[idx];
          if (input === undefined) {
            throw new Error(`Invalid index!`);
          }
        } else {
          while (true) {
            input = verifierInputs[idx];
            if (input !== undefined) {
              break;
            } else {
              const voteFor = verifierInputs.length > 0 &&
                Hash.equals(verifier.contract_hash, frontierHash) &&
                verifierInputs[verifierInputs.length - 1].block.hash;
              verifierInputs.push(
                await this.ctx.get(UnclaimedOutputService).claim(
                  verifier,
                  workerDriver.done.signal,
                  voteFor
                    ? (spec) => Hash.equals(spec.block.frontier_vote, voteFor)
                    : undefined,
                ),
              );
            }
          }
        }

        workerDriver.resumeTimer();
        return {
          blockHash: input.block.hash,
          blockTimestamp: input.block.timestamp,
          outputIdx: input.outputIdx,
          ...input.block.outputs[input.outputIdx],
        };
      },

      requireFrontierLevel(level) {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        if (frontierLevel === undefined) {
          frontierLevel = level;
        } else if (frontierLevel !== level) {
          // Ingenerable
          throw COMPUTE_INGENERABLE_FLAG;
        }
      },

      compareBlockOrder(hashA: Hash, hashB: Hash) {
        // TODO: Lock frontier hash and return an ordering wrt. the frontier
        return Hash.compare(hashA, hashB);
      },

      // validate() {
      //   throw COMPUTE_VALIDATE_FLAG;
      // },
      // invalidate() {
      //   throw COMPUTE_INVALIDATE_FLAG;
      // },
      // setValid(valid: boolean) {
      //   if (valid) {
      //     throw COMPUTE_VALIDATE_FLAG;
      //   } else throw COMPUTE_INVALIDATE_FLAG;
      // },

      pass() {
        throw COMPUTE_GENERABLE_FLAG;
      },
      fail() {
        throw COMPUTE_INGENERABLE_FLAG;
      },
      setResult(pass: boolean) {
        if (pass) {
          throw COMPUTE_GENERABLE_FLAG;
        } else {
          throw COMPUTE_INGENERABLE_FLAG;
        }
      },

      offsetCanonicality(offset: bigint) {
        return todo();
      },

      ingenerable: () => {
        // Ingenerable
        throw COMPUTE_INGENERABLE_FLAG;
      },

      finalize: async (err: unknown) => {
        if (err !== COMPUTE_GENERABLE_FLAG) {
          console.error(`Cannot generate: `, err);
          return;
        }

        // if (
        //   refs.length === 0 && verifierInputs.length === 0 &&
        //   otherInputs.length === 0 && outputs.length === 0 &&
        //   body === undefined && frontierLevel === undefined &&
        //   timestampGte === undefined
        // ) {
        //   console.warn(`Skipping generation of empty block`);
        //   return;
        // }

        workerDriver.pauseTimer(`finalize()`);

        if (timestampGte !== undefined) {
          // TODO: There might be a better way to do this?
          const wait = Number(timestampGte) -
            this.ctx.config.timeProvider.now();
          if (wait > 0) {
            await new Promise<void>((resolve) =>
              this.ctx.get(ClockService).setTimeout(resolve, wait)
            );
          }
        }

        // If this property was never retrieved, we can assume the generator created a correct block.
        const isCorrect = emitCorrect ?? true;

        const blockSpec: BlockSpec = {
          refs,
          inputs: [...verifierInputs, ...otherInputs],
          satisfies: verifierInputs.length ? undefined : [verifier],
          outputs,
          body,
          frontierLevel,
          // timestampGte,
        };

        workerDriver.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Creating block...`,
        });
        await this.createBlock(verifier, blockSpec, 0);
        workerDriver.resumeTimer();
      },
    };
  }

  private shouldEmitCorrect(verifier: Verifier) {
    return Hash.compare(
      Hash.digest(arrConcat(
        this.secret,
        verifier.contract_hash.toBytes(),
        verifier.params,
      )),
      this.attemptDupeFraction,
    ) === 1;
  }

  private async createBlock(
    verifier: Verifier,
    spec: BlockSpec,
    durationMs: number,
  ) {
    if (Hash.equals(verifier.contract_hash, rootHash)) {
      // Special case for root contracts - don't publish the plaintext immediately.
      // This prevents others from stealing it and re-publishing it in their own block.
      // Instead, wait for a time.
      // TODO: Wait for our block to become canonical in the blockset.

      const block = this.ctx.get(BlockBuilder).buildBlock(spec);

      const publishDelay = 500 + Math.random() * 500;
      const publishAt = this.ctx.config.timeProvider.now() + publishDelay;

      const fact = this.ctx.get(FactService).emit(
        block,
        Block,
        FactType.Block,
        false,
        (fact) => {
          if (fact.type !== FactType.Block) {
            throw new Error(`Internal error! Invalid fact type ${fact.type}`);
          }
          fact.publishAt = publishAt;
        },
      );
      if (fact.type !== FactType.Block) {
        throw new Error(`Internal error! Invalid fact type ${fact.type}`);
      }

      // TODO: Instead of just waiting for a timeout, wait until the block has been included in a canonical N-level blockset tree.
      this.ctx.get(ClockService).setTimeout(
        () => this.ctx.get(FactService).publish(fact),
        publishDelay,
      );

      return fact;
    }

    console.log('GENERATE', spec);
    const block = await this.ctx.get(BlockBuilder).publish(spec);

    // answer.difficultyEstimate = BigInt(durationMs) *
    //   this.ctx.config.approxComputePricePerSecond / 1000n;
    // const hash = Hash.digest(Verifier.encode(verifier));

    // // Special case for epoch blocks; we need to send the epoch inclusion proof to all inputs
    // if (Hash.equals(verifier.contract_hash, epochHash)) {
    //   blockExt.isEpoch = true;

    //   this.ctx.get(EpochInclusionProofService).updateProof(
    //     blockExt.epochInclusionProofs,
    //     {
    //       block_hash: blockExt.hash,
    //       epoch_hash: blockExt.hash,
    //       input_indices: [],
    //     },
    //     blockExt,
    //   );
    // }

    if (this.ctx.config.dbgVerifyGenerations) {
      for (let i = 0; i < block.inputs.length; i++) {
        const input = block.inputs[i];
        const inputBlock = this.ctx.get(BlockService).get(input.block_hash);
        if (inputBlock !== undefined) {
          const verifier = inputBlock.outputs[input.output_idx].verifier;
          this.ctx.get(VerificationService)
            .enqueueVerification(block, verifier, [CollateralHint.encode({
              hint: { CollateralHintVerifier: { input_idx: i } },
            })], 0);
        }
      }
    }

    if (this.isImmediatelyVerifiable(block) !== true) {
      this.ctx.get(LitigationService).litigate(block, [], 'VALID_CHALLENGE');
    }

    return block;
  }

  // private litigateBlockVerifier(
  //   block: BlockFact,
  //   verifier: Verifier,
  //   isValid: boolean,
  //   hint: Uint8Array = new Uint8Array(),
  // ) {
  //   const idx = block.inputs.findIndex((input) => {
  //     const fact = this.ctx.get(FactService).get(input.block_hash);
  //     if (fact !== undefined && fact.type === FactType.Block) {
  //       const v2 = fact.outputs[input.output_idx].verifier;
  //       return Hash.equals(v2.contract_hash, verifier.contract_hash) &&
  //         arrEquals(v2.params, verifier.params);
  //     }
  //   });
  //   if (idx === -1) {
  //     throw new Error(
  //       `Cannot find block input with correct verifier for litigation!`,
  //     );
  //   }

  //   if (isValid) {
  //     this.ctx.get(LitigationService).litigateBlock(block, {
  //       ClaimVerificationPassed: { input_idx: idx, hint },
  //     });
  //   } else {
  //     this.ctx.get(LitigationService).litigateBlock(block, {
  //       ClaimVerificationFailed: { input_idx: idx, hint },
  //     });
  //   }
  // }

  private isImmediatelyVerifiable(block: BlockFact) {
    for (const input of block.inputs) {
      const inputBlock = this.ctx.get(BlockService).get(input.block_hash);
      if (inputBlock === undefined) {
        return undefined;
      }
      const { verifier } = inputBlock.outputs[input.output_idx];
      if (
        !this.ctx.get(ContractClassifierService)
          .isImmediatelyVerifiable(verifier)
      ) {
        return false;
      }
    }
    return true;
  }

  public snapshot() {
    return { running: this.running };
  }
}
