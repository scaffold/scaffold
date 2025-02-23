import { BlockBuilder, BlockDraft, InputSpec, OutputSpec } from './BlockBuilder.ts';
import { BlockService } from './BlockService.ts';
import { accountHash, frontierHash, generatorHash, rootHash, trueHash } from './hashes.ts';
import { Context } from './Context.ts';
import { WorkerDriver, WorkerDriverService } from './WorkerDriverService.ts';
import { LocalGeneratorService } from './LocalGeneratorService.ts';
import { AccountContractParams, Block, BlockOutput, Verifier } from './messages.ts';
import { arrConcat, arrEquals, EMPTY_ARR } from './util/buffer.ts';
import { assert, error, todo } from './util/functional.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { WorkerExecutor } from './WorkerExecutor.ts';
import { LitigationService } from './LitigationService.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { ClockService } from './ClockService.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { FetchService } from './FetchService.ts';
import { KeyService } from './KeyService.ts';
import { bin2hex } from './util/hex.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { CollateralHint } from './collateralMessages.ts';
import { ComputationDriver, ComputationType } from './ComputationMeta.ts';
import { VerificationService } from './VerificationService.ts';
import { retryAbortable } from './util/abortable.ts';
import { QaDebugger } from './QaDebugger.ts';
import { MergeabilityService } from './MergeabilityService.ts';
import { AvailableOutputManager } from './AvailableOutputManager.ts';
import { LogSystem } from './Config.ts';

interface RunState {
  verifierState: VerifierState;
  isMergeable(block: BlockFact, outputIdx?: number): boolean;
  acceptInput?(input: InputSpec): void;
}

interface VerifierState {
  verifier: Verifier;
  unclaimedInputs: InputSpec[];
  running: RunState[];
}

const GENERATION_SUCCESS_FLAG = Symbol('GenerationService.Success');
class GenerationException extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

export class GenerationService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);
  private secret: Uint8Array;

  // private states = new Map<HashPrimitive, VerifierState>();
  private running = new Set<HashPrimitive>();

  constructor(private ctx: Context) {
    this.secret = ctx.config.entropyProvider.cryptoRandomBytes(32);
  }

  public ensureRunning(verifier: Verifier) {
    const key = Hash.digest(Verifier.encode(verifier));
    if (!this.running.has(key.toPrimitive())) {
      const launch = this.launchRun(verifier);
      if (launch !== undefined) {
        this.running.add(key.toPrimitive());
        launch.finally(() => this.running.delete(key.toPrimitive()));
      }
    }
  }

  // private addInput(input: InputSpec) {
  //   if (input.amount <= 0n) {
  //     return;
  //   }

  //   const verifier = input.block.outputs[input.outputIdx].verifier;

  //   if (
  //     Hash.equals(verifier.contractHash, accountHash) &&
  //     !arrEquals(
  //       AccountContractParams.decode(verifier.params).publicKey,
  //       this.ctx.get(KeyService).getSelfPublicKey(),
  //     )
  //   ) {
  //     return;
  //   }

  //   const key = Hash.digest(Verifier.encode(verifier));
  //   const verifierState = mapPut(
  //     this.states,
  //     key.toPrimitive(),
  //     () => ({ verifier, unclaimedInputs: [], running: [] }),
  //   );

  //   this.insertInput(verifierState, input);
  // }

  // private removeInput(input: InputSpec) {
  //   const verifier = input.block.outputs[input.outputIdx].verifier;
  //   const key = Hash.digest(Verifier.encode(verifier));
  //   const state = this.states.get(key.toPrimitive());
  //   if (state !== undefined) {
  //     state.unclaimedInputs = state.unclaimedInputs.filter((x) =>
  //       x.block !== input.block || x.outputIdx !== input.outputIdx
  //     );
  //   }
  // }

  // private claimInput(verifier: Verifier, pred?: (input: InputSpec) => boolean) {
  //   const key = Hash.digest(Verifier.encode(verifier));
  //   const state = this.states.get(key.toPrimitive());
  //   if (state !== undefined) {
  //     if (pred !== undefined) {
  //       const idx = state.unclaimedInputs.findIndex(pred);
  //       if (idx !== -1) {
  //         return state.unclaimedInputs.splice(idx, 1)[0];
  //       }
  //     } else {
  //       return state.unclaimedInputs.shift();
  //     }
  //   }
  // }

  // private insertInput(verifierState: VerifierState, input: InputSpec) {
  //   const mergeable = verifierState.running.filter((run) =>
  //     run.isMergeable(input.block, input.outputIdx)
  //   );

  //   if (mergeable.length !== 0) {
  //     for (const runState of mergeable) {
  //       if (runState.acceptInput !== undefined) {
  //         runState.acceptInput(input);
  //         return;
  //       }
  //     }
  //   } else {
  //     const runState = { verifierState, isMergeable: () => true };
  //     const launch = this.launchRun(runState);
  //     if (launch !== undefined) {
  //       verifierState.running.push(runState);
  //       launch.then(() => {
  //         const idx = verifierState.running.indexOf(runState);
  //         if (idx === -1) {
  //           throw new Error(`Internal error!`);
  //         }
  //         verifierState.running.splice(idx, 1);
  //       });
  //     }
  //   }

  //   verifierState.unclaimedInputs.push(input);
  // }

  // private launchUnclaimed(verifierState: VerifierState) {
  //   const reinsert = verifierState.unclaimedInputs;
  //   verifierState.unclaimedInputs = [];

  //   for (const input of reinsert) {
  //     this.insertInput(verifierState, input);
  //   }
  // }

  private launchRun(verifier: Verifier): Promise<void> | undefined {
    if (Hash.equals(verifier.contractHash, accountHash)) {
      return;
    }

    const special = this.getGenerator(verifier.contractHash);
    if (special) {
      return this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeGenerationDriver(verifier, workerDriver);
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message: `Starting special generator for ${
              this.ctx.get(QaDebugger).debugVerifier(verifier)
            }`,
          });
          try {
            await special.compute(driver, this.ctx);
            await driver.finalize(GENERATION_SUCCESS_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        () => 0,
      );
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
        }, 0);

    const localGenerator = this.ctx.get(LocalGeneratorService)
      .getGenerator(verifier.contractHash);
    if (localGenerator) {
      return this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeGenerationDriver(verifier, workerDriver);
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message: `Starting local generator for ${
              this.ctx.get(QaDebugger).debugVerifier(verifier)
            }`,
          });
          try {
            await localGenerator(driver, this.ctx);
            await driver.finalize(GENERATION_SUCCESS_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        getScore,
      );
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contractHash: generatorHash,
        params: { value: { bytes: verifier.contractHash.toBytes() }, entries: [] },
      });
      if (generatorBlocks.length) {
        const generatorCode = generatorBlocks[0].block.bodies[generatorBlocks[0].groupIdx];

        return this.ctx.get(WorkerDriverService).run(
          async (workerDriver) => {
            await workerDriver.setAllocation({ webWorkerCount: 1 });
            const driver = this.makeGenerationDriver(verifier, workerDriver);
            workerDriver.log?.push({
              timestamp: this.ctx.config.timeProvider.now(),
              message: `Starting worker generator for ${verifier.contractHash.toHex()}:${
                bin2hex(verifier.params)
              }`,
            });
            try {
              await this.ctx.get(WorkerExecutor).run(
                {
                  code: generatorCode.value!.bytes,
                  readParamsJsonSchema: true,
                  // contractHash: verifier.contractHash.toBytes(),
                  // params: verifier.params,
                  // emitCorrect: this.shouldEmitCorrect(verifier),
                },
                driver,
              );
              await driver.finalize(GENERATION_SUCCESS_FLAG);
            } catch (err) {
              await driver.finalize(err);
            }
          },
          getScore,
        );
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
    const fulfillsVerifiers = [verifier];
    let inputs: InputSpec[] = [];
    let inputsAreFixed = false;
    const refs: BlockFact[] = [];
    // const satisfies:Verifier=[];
    const outputs: OutputSpec[] = [];
    // let frontierLevel: number | undefined;
    let timestampGte: bigint | undefined;

    const isMergeable = (
      testInput: { block: BlockFact; outputIdx?: number },
    ) => {
      // if (
      //   false &&
      //   outputIdx !== undefined && verifierInputs.length > 0 &&
      //   Hash.equals(state.verifierState.verifier.contractHash, frontierHash)
      // ) {
      //   const frontierCount = verifierInputs.filter((x) =>
      //     x.outputIdx === x.block.frontierOutputIdx
      //   ).length;
      //   if (frontierCount > frontierInputCount) {
      //     throw new Error(`Internal error!`);
      //   } else if (frontierCount === frontierInputCount) {
      //     return false;
      //   }

      //   const lastBlock = verifierInputs[verifierInputs.length - 1].block;
      //   return block.frontierVoteBlock !== undefined &&
      //     (block.frontierVoteBlock === lastBlock ||
      //       (block.frontierVoteBlock === lastBlock.frontierVoteBlock &&
      //         this.isFrontierMergeable(block, lastBlock)));
      // }

      return testInput.block.isCanonical && this.ctx.get(MergeabilityService).isMergeable([
        ...inputs.map((x) => x.block),
        ...refs,
        testInput.block,
      ]);
    };

    const collectInputs = () => {
      if (!inputsAreFixed) {
        for (const verifier of fulfillsVerifiers) {
          inputs = inputs.concat(
            this.ctx.get(AvailableOutputManager).popAll(verifier, isMergeable),
          );
        }
        inputsAreFixed = true;
      }
    };

    return {
      ...workerDriver,

      type: ComputationType.Generator,

      getVerifier: () => verifier,
      getContractHash: () => verifier.contractHash,
      getParams: () => verifier.params.value!.bytes,
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
            throw new GenerationException(
              `requireBody(...) called multiple times with different bodies!`,
            );
          }
        }
      },
      requireOutput: (output: OutputSpec) => {
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
      isSignedBy: (publicKey) => arrEquals(publicKey, this.ctx.get(KeyService).getSelfPublicKey()),
      requireSignature: (publicKey) => {
        // TODO: If we don't call this, maybe we don't necessarily need to sign the block?
        const selfPublicKey = this.ctx.get(KeyService).getSelfPublicKey();
        if (!arrEquals(publicKey, selfPublicKey)) {
          throw new GenerationException(
            `requireSignature(...) called with an unknown public key!`,
          );
        }
      },
      emitCorrect: () => {
        if (emitCorrect === undefined) {
          emitCorrect = this.shouldEmitCorrect(verifier);
        }
        return emitCorrect;
      },

      notify: (verifier) => {
        this.ctx.get(FetchService).fetch(verifier, {
          // TODO: Incentivize?
          abortSignal: workerDriver.done.signal,
        });
      },
      fetch: (verifier) =>
        new Promise((reply) => {
          if (workerDriver.done.signal.aborted) {
            // Never resolve
            return;
          }

          workerDriver.pauseTimer(
            `request(${this.ctx.get(QaDebugger).debugVerifier(verifier)})`,
          );

          const incentive = inputs.reduce((acc, input) => acc + input.amount, 0n) * 15n / 16n;

          // TODO: Check isMergeable() here

          // TODO: Call pause/resume when requesting?
          this.ctx.get(FetchService).fetch(verifier, {
            abortSignal: workerDriver.done.signal,
            incentive,
            onResponseBlock: (block, groupIdx) => {
              console.log('got req', { verifier, block });

              // TODO: If we get a non-canonical block (canonicality <= 0), we have to check if it's mergeable with the other inputs (positive and negative).
              // If it's not, or maybe just in any case of not having a canonical input:
              //   Any block can be made canonical by re-writing, and not claiming the disputed input(s).

              // TODO: Handle multiple resolutions, with blocks with the same and varying bodies.
              // TODO: Handle case when we already have a ref fulfilling the verifier.
              // TODO: Handle case when that ref gets replaced and no longer fulfills the verifier.

              refs.push(block);
              const body = block.bodies[groupIdx].value!.bytes;
              workerDriver.resumeTimer(
                `Fetched from ${block.hash.toHex().slice(0, 10)}: ${bin2hex(body).slice(0, 10)}`,
              );
              reply(body);
            },
          });
        }),

      collectInputs: () => {
        collectInputs();
        return inputs.map((input) => {
          const output = input.block.outputs[input.outputIdx];
          return {
            input,
            output,
            body: input.block.bodies[output.groupIdx].value!.bytes,
            timestamp: input.block.timestamp,
          };
        });
      },
      requireInput: async (satisfies, outputsTo) => {
        if (inputsAreFixed) {
          throw new Error(
            `Cannot call requireInput(...) after calling collectInputs()!`,
          );
        }

        workerDriver.pauseTimer(
          `requireInput(${
            satisfies !== undefined
              ? this.ctx.get(QaDebugger).debugVerifier(satisfies)
              : 'undefined'
          }, ${
            outputsTo !== undefined
              ? this.ctx.get(QaDebugger).debugVerifier(outputsTo)
              : 'undefined'
          })`,
        );

        let input: InputSpec | undefined;
        if (satisfies === undefined) {
          input = await this.ctx.get(AvailableOutputManager).waitFor(
            outputsTo ?? verifier,
            workerDriver.done.signal,
            isMergeable,
          );
          if (outputsTo !== undefined) {
            fulfillsVerifiers.push(outputsTo);
          }
        } else {
          input = await retryAbortable(
            (abort) =>
              this.ctx.get(AvailableOutputManager).waitFor(
                outputsTo ?? verifier,
                abort,
                (input) => {
                  if (!isMergeable(input)) {
                    return false;
                  }

                  const groupIdx = input.block.outputs[input.outputIdx].groupIdx;
                  return input.block.inputs.some((input) => {
                    if (input.groupIdx !== groupIdx) {
                      return false;
                    }
                    const inputBlock = this.ctx.get(BlockService)
                      .get(input.blockHash, false);
                    return inputBlock !== undefined &&
                      this.ctx.get(BlockService).areVerifiersEqual(
                        inputBlock.outputs[input.outputIdx].verifier,
                        satisfies,
                      );
                  });
                },
              ),
            workerDriver.done.signal,
          );
        }

        inputs.push(input);

        // let input: InputSpec | undefined;
        // while (true) {
        //   input = this.claimInput(
        //     outputsTo ?? verifier,
        //     (input) => {
        //       if (!state.isMergeable(input.block, input.outputIdx)) {
        //         return false;
        //       }
        //       if (satisfies !== undefined) {
        //         const test = input.block
        //           .verifiers[input.block.outputs[input.outputIdx].groupIdx];
        //         return test !== undefined && this.ctx.get(BlockService)
        //           .areVerifiersEqual(test, satisfies);
        //       } else {
        //         return true;
        //       }
        //     },
        //   );

        //   if (input !== undefined) {
        //     break;
        //   } else {
        //     await new Promise<void>((resolve) =>
        //       this.ctx.config.timeProvider.setTimeout(resolve, 100)
        //     );
        //   }
        // }

        const output = input.block.outputs[input.outputIdx];

        workerDriver.resumeTimer(
          `Linking to ${input.block.hash.toHex().slice(0, 10)}:${input.outputIdx}`,
        );

        return {
          input,
          output,
          body: input.block.bodies[output.groupIdx].value!.bytes,
          timestamp: input.block.timestamp,
        };
      },

      // requireFrontierLevel(level) {
      //   if (workerDriver.done.signal.aborted) {
      //     return;
      //   }
      //   if (frontierLevel === undefined) {
      //     frontierLevel = level;
      //   } else if (frontierLevel !== level) {
      //     // Ingenerable
      //     throw new GenerationException(
      //       `requireFrontierLevel(...) called multiple times with different levels!`,
      //     );
      //   }
      // },

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
        throw GENERATION_SUCCESS_FLAG;
      },
      fail(msg) {
        throw new GenerationException(msg ?? `fail() called!`);
      },

      offsetCanonicality(offset: bigint) {
        return todo();
      },

      ingenerable: (msg) => {
        // Ingenerable
        throw new GenerationException(msg ?? `ingenerable() called!`);
      },

      finalize: async (err: unknown) => {
        const isValid = err === GENERATION_SUCCESS_FLAG;
        workerDriver.pauseTimer(`finalize(${isValid ? 'VALID' : 'INVALID'})`);

        if (!isValid) {
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

        collectInputs();

        // If this property was never retrieved, we can assume the generator created a correct block.
        const isCorrect = emitCorrect ?? true;

        const desiredReward = this.ctx.config
          .getGenerationReward(verifier, workerDriver.getCpuTime());
        const depositedReward = inputs.reduce(
          (acc, input) => acc + input.amount,
          0n,
        );

        const blockDraft: BlockDraft = {
          groupIdx: Hash.equals(verifier.contractHash, frontierHash) ? 0 : undefined,
          refs,
          inputs,
          outputs,
          body,
          // frontierLevel,
          squashOutputAmount: depositedReward < desiredReward
            ? depositedReward - desiredReward
            : 0n,
          // timestampGte,
        };

        workerDriver.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Creating block...`,
        });
        const block = await this.createBlock(verifier, blockDraft);
        workerDriver.resumeTimer(`Created ${block.hash.toHex().slice(0, 10)}`);
      },
    };
  }

  /*
  private isFrontierMergeable(a: BlockFact, b: BlockFact) {
    const used = new Set<HashPrimitive>();

    const queue = [a, b];
    for (let i = 0; i < queue.length; i++) {
      const el = queue[i];

      for (const input of el.inputs) {
        const key = Hash.digestParts(input.blockHash, input.outputIdx);
        if (used.has(key.toPrimitive())) {
          return false;
        }
        used.add(key.toPrimitive());
      }

      if (el.frontierParams.level !== 0) {
        const children = el.inputs.flatMap((input) => {
          const block = this.ctx.get(BlockService).get(input.blockHash);
          return block !== undefined &&
              input.outputIdx === block.frontierOutputIdx
            ? [block]
            : [];
        });
        if (children.length !== frontierInputCount) {
          return false;
        }
        for (const child of children) {
          queue.push(child);
        }
      }
    }

    return true;
  }
  */

  private shouldEmitCorrect(verifier: Verifier) {
    return Hash.compare(
      Hash.digest(arrConcat(
        this.secret,
        verifier.contractHash.toBytes(),
        verifier.params.value!.bytes,
      )),
      this.attemptDupeFraction,
    ) === 1;
  }

  private createBlock(verifier: Verifier, draft: BlockDraft) {
    if (Hash.equals(verifier.contractHash, rootHash) && false) {
      // Special case for root contracts - don't publish the plaintext immediately.
      // This prevents others from stealing it and re-publishing it in their own block.
      // Instead, wait for a time.
      // TODO: Wait for our block to become canonical in the blockset.

      const block = this.ctx.get(BlockBuilder).buildBlock([draft]);

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
      // Or wait for canonicality being greater than some threshold
      this.ctx.get(ClockService).setTimeout(
        () => this.ctx.get(FactService).publish(fact, true),
        publishDelay,
      );

      return fact;
    }

    return new Promise<BlockFact>((resolve) => {
      assert(draft.onBlock === undefined);
      draft.onBlock = (block, groupIdx) => {
        resolve(block);

        if (this.ctx.config.dbgVerifyGenerations) {
          this.ctx.get(VerificationService).enqueueVerification(block, verifier, [
            CollateralHint.encode({ hint: { CollateralHintVerifier: { groupIdx } } }),
          ], 0);
        }

        if (this.isImmediatelyVerifiable(block) !== true) {
          this.ctx.get(LitigationService).litigate(
            block,
            [],
            'VALID_CHALLENGE',
          );
        }
      };

      this.ctx.get(BlockBuilder).publishPersistentDraft(draft);
    });

    // answer.difficultyEstimate = BigInt(durationMs) *
    //   this.ctx.config.approxComputePricePerSecond / 1000n;
    // const hash = Hash.digest(Verifier.encode(verifier));

    // // Special case for epoch blocks; we need to send the epoch inclusion proof to all inputs
    // if (Hash.equals(verifier.contractHash, epochHash)) {
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
  //       return Hash.equals(v2.contractHash, verifier.contractHash) &&
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
      const inputBlock = this.ctx.get(BlockService).get(input.blockHash);
      if (inputBlock === undefined) {
        return undefined;
      }
      const { verifier } = inputBlock.outputs[input.outputIdx];
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
    return {};
  }
}
