import { BlockBuilder, BlockDraft, InputSpec } from './BlockBuilder.ts';
import { BlockService } from './BlockService.ts';
import {
  accountHash,
  frontierHash,
  generatorHash,
  rootHash,
} from './constants.ts';
import { Context } from './Context.ts';
import { WorkerDriver, WorkerDriverService } from './WorkerDriverService.ts';
import { LocalGeneratorService } from './LocalGeneratorService.ts';
import {
  AccountContractParams,
  Block,
  BlockOutput,
  Verifier,
} from './messages.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { assert, error, todo } from './util/functional.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { WorkerExecutor } from './WorkerExecutor.ts';
import { LitigationService } from './LitigationService.ts';
import { Logger } from './Logger.ts';
import { BlockFact, FactSource, FactType } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { ClockService } from './ClockService.ts';
import { MaybePromise } from './util/types.ts';
import { FetchService } from './FetchService.ts';
import { KeyService } from './KeyService.ts';
import { bin2hex } from './util/hex.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { CollateralHint } from './collateralMessages.ts';
import {
  ComputationDriver,
  ComputationType,
  COMPUTE_GENERABLE_FLAG,
  COMPUTE_INGENERABLE_FLAG,
  InputSource,
} from './ComputationMeta.ts';
import { VerificationService } from './VerificationService.ts';
import { mapPut } from './util/map.ts';
import { FrontierChainService } from './FrontierChainService.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';

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

export class GenerationService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);
  private secret: Uint8Array;

  private states = new Map<HashPrimitive, VerifierState>();

  constructor(private ctx: Context) {
    this.secret = ctx.config.entropyProvider.randomBytes(32);
  }

  public addInput(input: InputSpec) {
    const verifier = input.block.outputs[input.outputIdx].verifier;

    if (
      Hash.equals(verifier.contractHash, accountHash) &&
      !arrEquals(
        AccountContractParams.decode(verifier.params).publicKey,
        this.ctx.get(KeyService).getSelfPublicKey(),
      )
    ) {
      return;
    }

    const key = Hash.digest(Verifier.encode(verifier));
    const verifierState = mapPut(
      this.states,
      key.toPrimitive(),
      () => ({ verifier, unclaimedInputs: [], running: [] }),
    );

    this.insertInput(verifierState, input);
  }

  public removeInput(input: InputSpec) {
    const verifier = input.block.outputs[input.outputIdx].verifier;
    const key = Hash.digest(Verifier.encode(verifier));
    const state = this.states.get(key.toPrimitive());
    if (state !== undefined) {
      state.unclaimedInputs = state.unclaimedInputs.filter((x) => x !== input);
    }
  }

  public claimInput(verifier: Verifier, pred?: (input: InputSpec) => boolean) {
    const key = Hash.digest(Verifier.encode(verifier));
    const state = this.states.get(key.toPrimitive());
    if (state !== undefined) {
      if (pred !== undefined) {
        const idx = state.unclaimedInputs.findIndex(pred);
        if (idx !== -1) {
          return state.unclaimedInputs.splice(idx, 1)[0];
        }
      } else {
        return state.unclaimedInputs.shift();
      }
    }
  }

  private insertInput(verifierState: VerifierState, input: InputSpec) {
    // Insert the input into the highest-

    const mergeable = verifierState.running.filter((run) =>
      run.isMergeable(input.block, input.outputIdx)
    );

    if (mergeable.length !== 0) {
      for (const runState of mergeable) {
        if (runState.acceptInput !== undefined) {
          runState.acceptInput(input);
          return;
        }
      }
    } else {
      const runState = { verifierState, isMergeable: () => true };
      const launch = this.launchRun(runState, input);
      if (launch !== undefined) {
        verifierState.running.push(runState);
        launch.then(() => {
          const idx = verifierState.running.indexOf(runState);
          if (idx === -1) {
            throw new Error(`Internal error!`);
          }
          verifierState.running.splice(idx, 1);

          this.launchUnclaimed(verifierState);
        });
        return;
      }
    }

    verifierState.unclaimedInputs.push(input);
  }

  private launchUnclaimed(verifierState: VerifierState) {
    const reinsert = verifierState.unclaimedInputs;
    verifierState.unclaimedInputs = [];

    for (const input of reinsert) {
      this.insertInput(verifierState, input);
    }
  }

  private launchRun(
    runState: RunState,
    initialInput: InputSpec,
  ): Promise<void> | undefined {
    const verifier = runState.verifierState.verifier;

    if (Hash.equals(verifier.contractHash, accountHash)) {
      return;
    }

    const special = this.getGenerator(verifier.contractHash);
    if (special) {
      return this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeGenerationDriver(
            runState,
            initialInput,
            workerDriver,
          );
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting special generator for ${verifier.contractHash.toHex()}:${
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
          const driver = this.makeGenerationDriver(
            runState,
            initialInput,
            workerDriver,
          );
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting local generator for ${verifier.contractHash.toHex()}:${
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
      );
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contractHash: generatorHash,
        params: verifier.contractHash.toBytes(),
      });
      if (generatorBlocks.length) {
        const generatorCode =
          generatorBlocks[0].block.bodies[generatorBlocks[0].groupIdx];

        return this.ctx.get(WorkerDriverService).run(
          async (workerDriver) => {
            await workerDriver.setAllocation({ webWorkerCount: 1 });
            const driver = this.makeGenerationDriver(
              runState,
              initialInput,
              workerDriver,
            );
            workerDriver.log?.push({
              timestamp: this.ctx.config.timeProvider.now(),
              message:
                `Starting worker generator for ${verifier.contractHash.toHex()}:${
                  bin2hex(verifier.params)
                }`,
            });
            try {
              await this.ctx.get(WorkerExecutor).run(
                {
                  code: generatorCode,
                  // contractHash: verifier.contractHash.toBytes(),
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
    state: RunState,
    initialInput: InputSpec,
    workerDriver: WorkerDriver,
  ): ComputationDriver & { finalize(err: unknown): MaybePromise<void> } {
    let emitCorrect: boolean | undefined;

    let body: Uint8Array | undefined;
    let verifierInputs: InputSpec[] = [initialInput];
    const otherInputs: InputSpec[] = [];
    let inputsAreFixed = false;
    const refs: BlockFact[] = [];
    // const satisfies:Verifier=[];
    const outputs: BlockOutput[] = [];
    let frontierLevel: number | undefined;
    let timestampGte: bigint | undefined;

    state.isMergeable = (block: BlockFact, outputIdx?: number) => {
      if (
        false &&
        outputIdx !== undefined && verifierInputs.length > 0 &&
        Hash.equals(state.verifierState.verifier.contractHash, frontierHash)
      ) {
        const frontierCount = verifierInputs.filter((x) =>
          Hash.equals(
            x.block.outputs[x.outputIdx].verifier.contractHash,
            frontierHash,
          )
        ).length;
        if (frontierCount > frontierInputCount) {
          throw new Error(`Internal error!`);
        } else if (frontierCount === frontierInputCount) {
          return false;
        }

        const lastBlock = verifierInputs[verifierInputs.length - 1].block;
        return block.frontierVoteBlock !== undefined &&
          (block.frontierVoteBlock === lastBlock ||
            (block.frontierVoteBlock === lastBlock.frontierVoteBlock &&
              this.isFrontierMergeable(block, lastBlock)));
      }

      return this.ctx.get(FrontierChainService).getVote([
        ...verifierInputs,
        ...otherInputs,
        ...refs.map((ref) => ({ block: ref })),
        { block, outputIdx },
      ]) !== undefined;
    };

    const collectInputs = () => {
      if (!inputsAreFixed) {
        state.verifierState.unclaimedInputs = state.verifierState
          .unclaimedInputs.filter((input) => {
            if (state.isMergeable(input.block, input.outputIdx)) {
              verifierInputs.push(input);
              return false;
            } else {
              return true;
            }
          });
        inputsAreFixed = true;
      }
    };

    this.launchUnclaimed(state.verifierState);

    return {
      ...workerDriver,

      type: ComputationType.Generator,

      getContractHash: () => state.verifierState.verifier.contractHash,
      getParams: () => state.verifierState.verifier.params,
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
          emitCorrect = this.shouldEmitCorrect(state.verifierState.verifier);
        }
        return emitCorrect;
      },

      notify: (contractHash, params) => {
        this.ctx.get(FetchService).fetch(
          { contractHash: contractHash, params },
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

          const verifier = { contractHash: contractHash, params };

          // TODO: Check isMergeable() here

          // TODO: Call pause/resume when requesting?
          this.ctx.get(FetchService).fetch(
            verifier,
            { abortSignal: workerDriver.done.signal },
            (result, block) => {
              this.ctx.get(Logger).info('got req', { verifier, block });

              // TODO: If we get a non-canonical block (canonicality <= 0), we have to check if it's mergeable with the other inputs (positive and negative).
              // If it's not, or maybe just in any case of not having a canonical input:
              //   Any block can be made canonical by re-writing, and not claiming the disputed input(s).

              // TODO: Handle multiple resolutions, with blocks with the same and varying bodies.
              // TODO: Handle case when we already have a ref fulfilling the verifier.
              // TODO: Handle case when that ref gets replaced and no longer fulfills the verifier.

              refs.push(block);
              workerDriver.resumeTimer();
              reply(result);
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
        collectInputs();
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
              const idx = state.verifierState.unclaimedInputs
                .findIndex((input) =>
                  state.isMergeable(input.block, input.outputIdx)
                );
              if (idx !== -1) {
                verifierInputs.push(
                  state.verifierState.unclaimedInputs.splice(idx, 1)[0],
                );
              } else {
                await new Promise<void>((resolve) => {
                  state.acceptInput = (input) => {
                    state.acceptInput = undefined;
                    verifierInputs.push(input);
                    resolve();
                  };
                });
              }
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

        collectInputs();

        // If this property was never retrieved, we can assume the generator created a correct block.
        const isCorrect = emitCorrect ?? true;

        const blockDraft: BlockDraft = {
          refs,
          inputs: [...verifierInputs, ...otherInputs],
          satisfies: verifierInputs.length
            ? undefined
            : [state.verifierState.verifier],
          outputs,
          body,
          frontierLevel,
          // timestampGte,
        };

        workerDriver.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Creating block...`,
        });
        this.createBlock(state.verifierState.verifier, blockDraft, 0);
        workerDriver.resumeTimer();
      },
    };
  }

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
          return block !== undefined && Hash.equals(
              block.outputs[input.outputIdx].verifier.contractHash,
              frontierHash,
            )
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

  private shouldEmitCorrect(verifier: Verifier) {
    return Hash.compare(
      Hash.digest(arrConcat(
        this.secret,
        verifier.contractHash.toBytes(),
        verifier.params,
      )),
      this.attemptDupeFraction,
    ) === 1;
  }

  private createBlock(
    verifier: Verifier,
    draft: BlockDraft,
    durationMs: number,
  ) {
    if (Hash.equals(verifier.contractHash, rootHash)) {
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
      this.ctx.get(ClockService).setTimeout(
        () => this.ctx.get(FactService).publish(fact),
        publishDelay,
      );

      return fact;
    }

    // console.log('GENERATE', draft);
    assert(draft.onBlock === undefined);
    draft.onBlock = (block, groupIdx) => {
      if (this.ctx.config.dbgVerifyGenerations) {
        this.ctx.get(VerificationService)
          .enqueueVerification(block, verifier, [CollateralHint.encode({
            hint: { CollateralHintVerifier: { groupIdx } },
          })], 0);
      }

      if (this.isImmediatelyVerifiable(block) !== true) {
        this.ctx.get(LitigationService).litigate(block, [], 'VALID_CHALLENGE');
      }
    };
    this.ctx.get(BlockBuilder).publishPersistentDraft(draft);

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
    return { states: this.states };
  }
}
