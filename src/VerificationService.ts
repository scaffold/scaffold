import BlockService from './BlockService.ts';
import { frontierHash, rootHash } from './constants.ts';
import Context from './Context.ts';
import WorkerDriverService, { WorkerDriver } from './WorkerDriverService.ts';
import { BlockOutput, FrontierTreeParams, Verifier } from './messages.ts';
import { arrEquals } from './util/buffer.ts';
import { todo } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import WorkerExecutor from './WorkerExecutor.ts';
import LitigationService from './LitigationService.ts';
import { BlockFact } from './FactMeta.ts';
import FactService from './FactService.ts';
import { MaybePromise } from './util/types.ts';
import { bin2hex } from './util/hex.ts';
import { DetailVote } from './CollateralUtil.ts';
import HintSuggestionService from './HintSuggestionService.ts';
import {
  BurdenOfProof,
  ComputationDriver,
  ComputationType,
  COMPUTE_FAIL_FLAG,
  COMPUTE_PASS_FLAG,
} from './ComputationMeta.ts';

export default class VerificationService {
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

    const special = this.getVerifier(verifier.contract_hash);
    if (special) {
      this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeVerificationDriver(
            block,
            verifier,
            hintPrefix,
            workerDriver,
          );
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting special verifier for ${verifier.contract_hash.toHex()}:${
                bin2hex(verifier.params)
              }`,
          });
          try {
            await special.compute(driver, this.ctx);
            await driver.finalize(COMPUTE_PASS_FLAG);
          } catch (err) {
            await driver.finalize(err);
          }
        },
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
      ).then(() => this.extraContractIncentive.delete(runHash.toPrimitive()));
      return;
    }

    const contractBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
      contract_hash: rootHash,
      params: verifier.contract_hash.toBytes(),
    });
    if (contractBlocks.length) {
      const contractCode = contractBlocks[0].body;

      this.ctx.get(WorkerDriverService).run(
        async (workerDriver) => {
          await workerDriver.setAllocation({});
          const driver = this.makeVerificationDriver(
            block,
            verifier,
            hintPrefix,
            workerDriver,
          );
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting worker verifier for ${verifier.contract_hash.toHex()}:${
                bin2hex(verifier.params)
              }`,
          });
          try {
            await this.ctx.get(WorkerExecutor).run(
              {
                code: contractCode,
                // contractHash: verifier.contract_hash.toBytes(),
                // params: verifier.params,
                // body: block.body,
                // emitCorrect: true,
              },
              driver,
            );
            await driver.finalize(COMPUTE_PASS_FLAG);
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
    const hints = hintPrefix.slice(0, 1);
    let requireInputCount: number | undefined;
    let nextOutputIdx = 0;

    return {
      ...workerDriver,

      type: ComputationType.Contract,

      getContractHash: () => verifier.contract_hash,
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

        if (idx > hints.length) {
          throw new Error(`Must get hints in order at index ${idx}!`);
        } else if (idx === hints.length) {
          this.ctx.get(LitigationService).litigate(block, hints, vote);
          if (idx < hintPrefix.length) {
            hints.push(hintPrefix[idx]);
          } else {
            const suggestions = this.ctx.get(HintSuggestionService)
              .suggest(block, hints);
            if (suggestions.length === 0) {
              throw new Error(
                `Hint required but we don't have any suggestions!`,
              );
            }
            // TODO: Make this crypto random
            const random = this.ctx.config.entropyProvider.randomNumber();
            hints.push(suggestions[Math.floor(random * suggestions.length)]);
          }
        } else {
          this.ctx.get(LitigationService)
            .litigate(block, hints.slice(0, idx), vote);
        }

        return hints[idx];
      },
      getBody: () => block.body,
      requireBody: (data) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        if (!arrEquals(block.body, data)) {
          throw COMPUTE_FAIL_FLAG;
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
        throw COMPUTE_FAIL_FLAG;
      },
      requireTimestampGte: (timestamp: bigint) => {
        if (block.timestamp < timestamp) {
          throw COMPUTE_FAIL_FLAG;
        }
      },
      requireSignature: (publicKey) => {
        if (!this.ctx.get(FactService).verify(block, publicKey)) {
          throw COMPUTE_FAIL_FLAG;
        }
      },
      emitCorrect: () => {
        throw new Error(`Cannot call emitCorrect() from a contract!`);
      },

      notify: (_contractHash, _params) => {},
      request: async (contractHash, params) => {
        if (workerDriver.done.signal.aborted) {
          // Should have already interrupted earlier
          throw new Error(`Internal error`);
        }

        workerDriver.pauseTimer(
          `request(${contractHash.toHex()}, ${bin2hex(params)})`,
        );

        const verifier = { contract_hash: contractHash, params };
        for (const hash of block.refs) {
          const ref = await this.ctx.get(BlockService).waitForBlock(
            hash,
            workerDriver.done.signal,
          );

          if (
            await this.ctx.get(BlockService).doesBlockSatisfy(
              ref,
              verifier,
              workerDriver.done.signal,
            )
          ) {
            workerDriver.resumeTimer();
            return ref.body;
          }
        }
        throw COMPUTE_FAIL_FLAG;
      },

      fulfills: (_block: BlockFact, _outputIdx: number) => {
        // Do nothing here; the way to tell if this block A indeed fulfills B's output is to input the output then verify.
      },

      getInputCount: async () => {
        workerDriver.pauseTimer(`getInputCount()`);

        let count = 0;
        for (const input of block.inputs) {
          const block = await this.ctx.get(BlockService).waitForBlock(
            input.block_hash,
            workerDriver.done.signal,
          );

          const output = block.outputs[input.output_idx];
          if (
            this.ctx.get(BlockService).areVerifiersEqual(
              output.verifier,
              verifier,
            )
          ) {
            count++;
          }
        }

        workerDriver.resumeTimer();
        return count;
      },
      getInputSource: async (idx: number) => {
        workerDriver.pauseTimer(`getInputSource(${idx})`);

        if (requireInputCount === undefined || requireInputCount <= idx) {
          requireInputCount = idx + 1;
        }

        for (const input of block.inputs) {
          const inputBlock = await this.ctx.get(BlockService).waitForBlock(
            input.block_hash,
            workerDriver.done.signal,
          );

          const output = inputBlock.outputs[input.output_idx];
          if (
            this.ctx.get(BlockService).areVerifiersEqual(
              output.verifier,
              verifier,
            ) && idx-- === 0
          ) {
            workerDriver.resumeTimer();
            return {
              blockHash: inputBlock.hash,
              blockTimestamp: inputBlock.timestamp,
              outputIdx: input.output_idx,
              ...output,
            };
          }
        }

        throw COMPUTE_FAIL_FLAG;
      },

      requireFrontierLevel(level) {
        if (block.frontierParams.level !== level) {
          throw COMPUTE_FAIL_FLAG;
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
        throw COMPUTE_PASS_FLAG;
      },
      fail() {
        throw COMPUTE_FAIL_FLAG;
      },
      setResult(pass: boolean) {
        if (pass) {
          throw COMPUTE_PASS_FLAG;
        } else {
          throw COMPUTE_FAIL_FLAG;
        }
      },

      offsetCanonicality(offset: bigint) {
        return todo();
      },

      ingenerable: () => {
        throw new Error(`Cannot call ingenerable() from a contract!`);
      },

      finalize: async (err: unknown) => {
        workerDriver.pauseTimer(`finalize()`);

        const isValid = err === COMPUTE_PASS_FLAG;
        if (isValid) {
          if (requireInputCount !== undefined) {
            let count = 0;
            for (const input of block.inputs) {
              const block = await this.ctx.get(BlockService)
                .waitForBlock(input.block_hash, workerDriver.done.signal);

              const output = block.outputs[input.output_idx];
              if (
                this.ctx.get(BlockService)
                  .areVerifiersEqual(output.verifier, verifier) &&
                ++count > requireInputCount
              ) {
                throw COMPUTE_FAIL_FLAG;
              }
            }

            if (count !== requireInputCount) {
              throw COMPUTE_FAIL_FLAG;
            }
          }
        } else {
          console.error(`Verification failed:`, err);
        }

        const vote = isValid ? 'FINAL_PASS' : 'FINAL_FAIL';
        try {
          this.ctx.get(LitigationService).litigate(block, hints, vote);
        } catch (err) {
          console.error(`Litigation failed:`, err);
        }
        workerDriver.done.abort();

        workerDriver.resumeTimer();
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

  private areOutputsEqual(a: BlockOutput, b: BlockOutput) {
    return Hash.equals(a.verifier.contract_hash, b.verifier.contract_hash) &&
      arrEquals(a.verifier.params, b.verifier.params) &&
      a.amount === b.amount &&
      arrEquals(a.detail, b.detail);
  }

  public snapshot() {
    return { extraContractIncentive: this.extraContractIncentive };
  }
}
