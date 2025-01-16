import { BlockService } from './BlockService.ts';
import { frontierHash, rootHash } from './hashes.ts';
import { Context } from './Context.ts';
import { WorkerDriver, WorkerDriverService } from './WorkerDriverService.ts';
import { BlockOutput, FrontierTreeParams, Verifier } from './messages.ts';
import { arrEquals } from './util/buffer.ts';
import { todo } from './util/functional.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { WorkerExecutor } from './WorkerExecutor.ts';
import { LitigationService } from './LitigationService.ts';
import { BlockFact } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { bin2hex } from './util/hex.ts';
import { DetailVote } from './CollateralUtil.ts';
import { HintSuggestionService } from './HintSuggestionService.ts';
import { BurdenOfProof, ComputationDriver, ComputationType } from './ComputationMeta.ts';
import { CollateralHint } from './collateralMessages.ts';
import { VerifierHelper } from './VerifierHelper.ts';
import { QaDebugger } from './QaDebugger.ts';

const VERIFICATION_SUCCESS_FLAG = Symbol('VerificationService.Success');
class VerificationException extends Error {
  constructor(
    msg: string,
  ) {
    super(msg);
  }
}

export class VerificationService {
  private extraContractIncentive = new Map<HashPrimitive, number>();

  constructor(private ctx: Context) {}

  public enqueueVerification(
    block: BlockFact,
    verifier: Verifier,
    hintPrefix: Uint8Array[],
    extraIncentive: number,
  ) {
    if (!this.ctx.config.enableValidation) {
      return;
    }

    // TODO: Key by: block.hash, verifier, hintPrefix.slice(1)
    const runHash = Hash.digestParts(block.hash, ...hintPrefix);
    if (this.extraContractIncentive.has(runHash.toPrimitive())) {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const special = this.getVerifier(verifier.contractHash);
    if (special) {
      this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeVerificationDriver(block, verifier, hintPrefix, workerDriver);
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message: `Starting special verifier for ${
              this.ctx.get(QaDebugger).debugVerifier(verifier)
            }`,
          });
          try {
            await special.compute(driver, this.ctx);
            await driver.finalize(VERIFICATION_SUCCESS_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
      ).then(() => this.extraContractIncentive.delete(runHash.toPrimitive()));
      return;
    }

    const contractBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
      contractHash: rootHash,
      params: verifier.contractHash.toBytes(),
    });
    if (contractBlocks.length) {
      const contractCode = contractBlocks[0].block.bodies[contractBlocks[0].groupIdx];

      this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeVerificationDriver(block, verifier, hintPrefix, workerDriver);
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message: `Starting worker verifier for ${
              this.ctx.get(QaDebugger).debugVerifier(verifier)
            }`,
          });
          try {
            await this.ctx.get(WorkerExecutor).run(
              {
                code: contractCode,
                // contractHash: verifier.contractHash.toBytes(),
                // params: verifier.params,
                // body: block.body,
                // emitCorrect: true,
              },
              driver,
            );
            await driver.finalize(VERIFICATION_SUCCESS_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
      ).then(() => this.extraContractIncentive.delete(runHash.toPrimitive()));
    }
  }

  private getVerifier(contractHash: Hash) {
    for (const provider of this.ctx.config.contractProviders) {
      if (Hash.equals(provider.contractHash, contractHash)) {
        return provider;
      }
    }
  }

  private makeVerificationDriver(
    block: BlockFact,
    verifier: Verifier,
    hintPrefix: Uint8Array[],
    workerDriver: WorkerDriver,
  ): ComputationDriver & { finalize(err: unknown): MaybePromise<void> } {
    const rootHint = CollateralHint.decode(hintPrefix[0]).hint;
    if (!('CollateralHintVerifier' in rootHint)) {
      throw new Error(`Invalid root hint ${JSON.stringify(rootHint)}`);
    }
    const groupIdx = rootHint.CollateralHintVerifier.groupIdx;

    const readHints = hintPrefix.slice(0, 1);
    let nextInputIdx = 0;
    let nextOutputIdx = 0;

    return {
      ...workerDriver,

      type: ComputationType.Contract,

      getVerifier: () => verifier,
      getContractHash: () => verifier.contractHash,
      getParams: () => verifier.params,
      getHint: (idx, bop) => {
        idx++;

        let vote: DetailVote;
        switch (bop) {
          case BurdenOfProof.Invalidation:
            vote = 'ALL_VALID_CONTEST';
            break;
          case BurdenOfProof.Validation:
            vote = 'ONE_VALID_CONTEST';
            break;
        }

        if (idx > readHints.length) {
          throw new Error(`Must get hints in order at index ${idx}!`);
        } else if (idx === readHints.length) {
          this.ctx.get(LitigationService).litigate(block, readHints, vote);
          if (idx < hintPrefix.length) {
            readHints.push(hintPrefix[idx]);
          } else {
            const suggestions = this.ctx.get(HintSuggestionService)
              .suggest(block, readHints);
            if (suggestions.length === 0) {
              throw new Error(
                `Hint required but we don't have any suggestions!`,
              );
            }
            // TODO: Make this crypto random
            const random = this.ctx.config.entropyProvider.randomNumber();
            readHints.push(
              suggestions[Math.floor(random * suggestions.length)],
            );
          }
        } else {
          this.ctx.get(LitigationService)
            .litigate(block, readHints.slice(0, idx), vote);
        }

        return readHints[idx];
      },
      getBody: () => block.bodies[groupIdx],
      requireBody: (data) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        if (!arrEquals(block.bodies[groupIdx], data)) {
          throw new VerificationException(
            `requireBody(...) failed - the block's body does not match the contract's specification!`,
          );
        }
      },
      requireOutput: (output: BlockOutput) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        while (nextOutputIdx !== block.outputs.length) {
          const candidate = block.outputs[nextOutputIdx++];
          if (this.areOutputsEqual(candidate, output)) {
            return;
          }
        }
        throw new VerificationException(
          `requireOutput(...) failed - there aren't any block outputs matching the contract's specification!`,
        );
      },
      requireTimestampGte: (timestamp: bigint) => {
        if (block.timestamp < timestamp) {
          throw new VerificationException(
            `requireTimestampGte(...) failed - the block's timestamp is less than contract's specification!`,
          );
        }
      },
      isSignedBy: (publicKey) => this.ctx.get(FactService).verify(block, publicKey),
      requireSignature: (publicKey) => {
        if (!this.ctx.get(FactService).verify(block, publicKey)) {
          throw new VerificationException(
            `requireSignature(...) failed - the block's signature does not match the contract's specification!`,
          );
        }
      },
      emitCorrect: () => true,

      notify: (_verifier) => {},
      fetch: async (verifier) => {
        if (workerDriver.done.signal.aborted) {
          // Should have already interrupted earlier
          throw new Error(`Internal error`);
        }

        workerDriver.pauseTimer(
          `fetch(${this.ctx.get(QaDebugger).debugVerifier(verifier)})`,
        );

        for (const hash of block.refs) {
          const ref = await this.ctx.get(BlockService)
            .waitForBlock(hash, workerDriver.done.signal);

          const groupIdx = await this.ctx.get(BlockService)
            .getGroupIndex(ref, verifier, workerDriver.done.signal);
          if (groupIdx !== undefined) {
            const body = ref.bodies[groupIdx];
            workerDriver.resumeTimer(
              `Read from ${ref.hash.toHex().slice(0, 10)}: ${bin2hex(body).slice(0, 10)}`,
            );
            return body;
          }
        }

        throw new VerificationException(
          `fetch(...) failed - no refs match the specified verifier!`,
        );
      },

      collectInputs: () => {
        nextInputIdx = block.inputs.length;
        return Promise.all(
          block.inputs.filter((x) => x.groupIdx === groupIdx).map(
            async (input) => {
              const inputBlock = await this.ctx.get(BlockService)
                .waitForBlock(input.blockHash, workerDriver.done.signal);

              const output = inputBlock.outputs[input.outputIdx];

              return {
                input: {
                  block: inputBlock,
                  outputIdx: input.outputIdx,
                  amount: output.amount,
                },
                output,
                body: inputBlock.bodies[output.groupIdx],
                timestamp: inputBlock.timestamp,
              };
            },
          ),
        );
      },
      requireInput: async (satisfies, outputsTo) => {
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

        // Do nothing here; the way to tell if this block A indeed fulfills B's output is to input the output then verify.

        while (nextInputIdx < block.inputs.length) {
          const input = block.inputs[nextInputIdx++];
          if (input.groupIdx !== groupIdx) {
            continue;
          }

          const inputBlock = await this.ctx.get(BlockService)
            .waitForBlock(input.blockHash, workerDriver.done.signal);

          const output = inputBlock.outputs[input.outputIdx];
          if (
            !this.ctx.get(BlockService)
              .areVerifiersEqual(output.verifier, outputsTo ?? verifier)
          ) {
            throw new VerificationException(
              `requireInput(...) failed - incorrect output verifier`,
            );
          }

          if (satisfies !== undefined) {
            if (
              !await this.ctx.get(BlockService).satisfies(
                inputBlock,
                output.groupIdx,
                satisfies,
                workerDriver.done.signal,
              )
            ) {
              throw new VerificationException(
                `requireInput(...) failed - incorrect input satisfaction`,
              );
            }
          }

          workerDriver.resumeTimer(
            `Linked to ${inputBlock.hash.toHex().slice(0, 10)}:${input.outputIdx}`,
          );

          return {
            input: {
              block: inputBlock,
              outputIdx: input.outputIdx,
              amount: output.amount,
            },
            output,
            body: inputBlock.bodies[output.groupIdx],
            timestamp: inputBlock.timestamp,
          };
        }

        throw new VerificationException(
          `requireInput(...) failed - there aren't enough inputs with the correct groupIdx!`,
        );
      },

      // requireFrontierLevel(level) {
      //   if (block.frontierParams.level !== level) {
      //     throw new VerificationException(
      //       `requireFrontierLevel(...) failed - the block's frontier level does not match the contract's specification!`,
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
        throw VERIFICATION_SUCCESS_FLAG;
      },
      fail(msg) {
        throw new VerificationException(msg ?? `fail() called!`);
      },

      offsetCanonicality(offset: bigint) {
        return todo();
      },

      ingenerable: () => {
        throw new Error(`Cannot call ingenerable() from a contract!`);
      },

      finalize: async (err: unknown) => {
        const isValid = err === VERIFICATION_SUCCESS_FLAG;
        workerDriver.pauseTimer(`finalize(${isValid ? 'VALID' : 'INVALID'})`);

        if (isValid) {
          if (nextInputIdx > 0) {
            while (nextInputIdx < block.inputs.length) {
              const input = block.inputs[nextInputIdx++];
              if (input.groupIdx === groupIdx) {
                throw new VerificationException(
                  `finalize(...) failed - there's too many inputs matching the contract's specification!`,
                );
              }
            }
          }
        } else {
          console.error(`Verification failed:`, err);
        }

        const vote = isValid ? 'FINAL_PASS' : 'FINAL_FAIL';
        try {
          this.ctx.get(LitigationService).litigate(block, readHints, vote);
        } catch (err) {
          console.error(`Litigation failed:`, err);
        }
        workerDriver.done.abort();

        workerDriver.resumeTimer(`Done`);
      },
    };
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

  private areOutputsEqual(a: BlockOutput, b: BlockOutput) {
    return Hash.equals(a.verifier.contractHash, b.verifier.contractHash) &&
      arrEquals(a.verifier.params, b.verifier.params) &&
      a.amount === b.amount &&
      arrEquals(a.detail, b.detail);
  }

  public snapshot() {
    return { extraContractIncentive: this.extraContractIncentive };
  }
}
