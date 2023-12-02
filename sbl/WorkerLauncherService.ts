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
import {
  Block,
  BlockOutput,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
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
import { DetailVote } from '~/sbl/CollateralUtil.ts';
import HintSuggestionService from '~/sbl/HintSuggestionService.ts';
import { CollateralHint } from '~/sbl/collateralMessages.ts';

// TODO: Split this file into ComputationMeta.ts, VerificationService.ts, and GenerationService.ts

export const enum ComputationType {
  Contract,
  Generator,
}

// https://docs.google.com/spreadsheets/d/1y3f2oqYwDaLRqoLnz4Jr1Ws7oO_muBPrv4ro9DQaIYw/edit
export const enum BurdenOfProof {
  Invalidation, // Used for most things; one hint proving invalidation makes the contract invalid. Self-votes are VALID, and a single INVALID child vote invalidates.
  Validation, // Used for things like hash inversions; one hint proving validation makes the hash valid. Self-votes are INVALID, and a single VALID child vote validates.
}

export interface InputSource extends BlockOutput {
  blockHash: Hash;
  blockTimestamp: bigint;
}

export interface ComputationDriver extends WorkerDriver {
  type: ComputationType;

  getContractHash(): Hash;
  getParams(): Uint8Array;
  getHint(idx: number, bop: BurdenOfProof): Uint8Array;
  getBody(): Uint8Array; // Only valid if this is a contract
  requireBody(data: Uint8Array): void; // Provide body if generator, require body equals if contract. Fast-path valid if pointer equals getBody().
  requireOutput(output: BlockOutput): void; // Same kind of thing as requireBody. Note that order matters here; the generator and contract must require outputs in the same order.
  requireTimestampGte(timestamp: bigint): MaybePromise<void>;
  requireSignature(publicKey: Uint8Array): void;
  emitCorrect(): boolean; // Whether to emit a correct answer or not; returns true if contract

  notify(contractHash: Hash, params: Uint8Array): void;
  request(contractHash: Hash, params: Uint8Array): Promise<Uint8Array>; // TODO: fetch?
  // invert(hash: Hash): MaybePromise<Uint8Array>;
  // fulfills(verifier: Verifier): void; // Something like this would allow bodies that fulfill multiple contracts. We'd still need a way to get the inputs/details. Although, perhaps this can be accomplished better with output details.
  fulfills(block: BlockFact, outputIdx: number): void;

  getInputCount(): MaybePromise<number>; // Returns the number of inputs matching this contractHash & params. When this is called, the value is fixed, and the return values from getInputSource() should be fixed.
  getInputSource(idx: number): MaybePromise<InputSource>; // Returns the input source at an index. The IO always has the same contractHash & params as this contract. If getInputCount() hasn't been called, block until we have another input.
  // TODO: Maybe make multiple getters for each property so we don't have to re-generate if, for example, only the block hash changes.

  requireFrontierLevel(level: number): void;

  compareBlockOrder(hashA: Hash, hashB: Hash): number; // Clamps the frontier vote

  // validate(): never;
  // invalidate(): never;
  // setValid(valid: boolean): never;

  // setBurdenOfProof(on: BurdenOfProof): void; // You can't call this after getting the hint, because we want it to be the same for ALL hints for any given verifier.
  pass(): never;
  fail(): never;
  setResult(pass: boolean): never;

  offsetCanonicality(offset: bigint): void;

  ingenerable(): void; // TODO: Maybe just throw an exception instead?
}

// A contract CANNOT require inputting a specific block hash. It can request the block data, but this won't make it dependent on that block.
// Note that a contract/generator can only read input IO addressed to its contractHash & params.

// export const COMPUTE_VALIDATE_FLAG = Symbol('ComputeLauncher.Validate');
// export const COMPUTE_INVALIDATE_FLAG = Symbol('ComputeLauncher.Invalidate');
export const COMPUTE_PASS_FLAG = Symbol('ComputeLauncher.Pass');
export const COMPUTE_FAIL_FLAG = Symbol('ComputeLauncher.Fail');
export const COMPUTE_GENERABLE_FLAG = Symbol('ComputeLauncher.Generable');
export const COMPUTE_INGENERABLE_FLAG = Symbol('ComputeLauncher.Ingenerable');

export default class WorkerLauncherService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);

  private extraContractIncentive = new Map<HashPrimitive, number>();
  private extraGeneratorIncentive = new Map<HashPrimitive, number>();

  private secret: Uint8Array;

  constructor(private ctx: Context) {
    this.secret = ctx.config.entropyProvider.randomBytes(32);
  }

  public enqueueVerification(
    block: BlockFact,
    verifier: Verifier,
    hintPrefix: Uint8Array[],
    extraIncentive: number,
  ) {
    if (!this.ctx.config.enableValidation) {
      return;
    }

    console.log('A', verifier.contract_hash.toHex());

    const runHash = Hash.digestParts(block.hash, ...hintPrefix);
    if (this.extraContractIncentive.has(runHash.toPrimitive())) {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const special = this.getSpecial(verifier.contract_hash);
    if (special) {
      this.ctx.get(WorkerDriverService).run(
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
        async (workerDriver) => {
          console.log('B', verifier.contract_hash.toHex());
          await workerDriver.setAllocation({});
          const driver = this.makeVerificationDriver(
            block,
            verifier,
            hintPrefix,
            workerDriver,
          );
          console.log('C', verifier.contract_hash.toHex());
          workerDriver.log?.push({
            timestamp: this.ctx.config.timeProvider.now(),
            message:
              `Starting special verifier for ${verifier.contract_hash.toHex()}:${
                bin2hex(verifier.params)
              }`,
          });
          try {
            console.log('D', verifier.contract_hash.toHex());
            await special.compute(driver, this.ctx);
            console.log('E', verifier.contract_hash.toHex());
            await driver.finalize(COMPUTE_PASS_FLAG);
            console.log('F', verifier.contract_hash.toHex());
          } catch (err) {
            await driver.finalize(err);
          }
        },
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
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
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
      ).then(() => this.extraContractIncentive.delete(runHash.toPrimitive()));
    }
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
    if (this.extraGeneratorIncentive.has(runHash.toPrimitive())) {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const special = this.getSpecial(verifier.contract_hash);
    if (special) {
      this.ctx.get(WorkerDriverService).run(
        () => this.extraGeneratorIncentive.get(runHash.toPrimitive())!,
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
      ).then(() => this.extraGeneratorIncentive.delete(runHash.toPrimitive()));
      return;
    }

    const getScore = () =>
      this.ctx.get(BlockService).getBlocksByOutput(verifier)
        .reduce((acc, { block, idx }) => {
          const { amount } = block.outputs[idx];
          const claims = block.outputClaims[idx];
          return claims.length === 0 && block.canonicality > 0
            ? acc + /* Math.exp(block.mergeableLogProbabilityValue) * */
              Number(amount)
            : acc;
        }, this.extraGeneratorIncentive.get(runHash.toPrimitive())!);

    const localGenerator = this.ctx.get(LocalGeneratorService).getGenerator(
      verifier.contract_hash,
    );
    if (localGenerator) {
      this.ctx.get(WorkerDriverService).run(
        getScore,
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
      ).then(() => this.extraGeneratorIncentive.delete(runHash.toPrimitive()));
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contract_hash: generatorHash,
        params: verifier.contract_hash.toBytes(),
      });
      if (generatorBlocks.length) {
        const generatorCode = generatorBlocks[0].body;

        this.ctx.get(WorkerDriverService).run(
          getScore,
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
        ).then(() =>
          this.extraGeneratorIncentive.delete(runHash.toPrimitive())
        );
      }
    }
  }

  private getSpecial(contractHash: Hash) {
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

    // Do litigation in here

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
          const block = await this.ctx.get(BlockService).waitForBlock(
            input.block_hash,
            workerDriver.done.signal,
          );

          const output = block.outputs[input.output_idx];
          if (
            this.ctx.get(BlockService).areVerifiersEqual(
              output.verifier,
              verifier,
            ) && idx-- === 0
          ) {
            workerDriver.resumeTimer();
            return {
              blockHash: block.hash,
              blockTimestamp: block.timestamp,
              ...output,
            };
          }
        }

        throw COMPUTE_FAIL_FLAG;
      },

      requireFrontierLevel(level) {
        const frontierOutputs = block.outputs.filter((output) =>
          Hash.equals(output.verifier.contract_hash, frontierHash)
        );
        if (frontierOutputs.length !== 1) {
          console.error(
            `Invalid number of frontier outputs ${frontierOutputs.length}!`,
          );
          throw COMPUTE_FAIL_FLAG;
        }
        const params = FrontierTreeParams.decode(
          frontierOutputs[0].verifier.params,
        );
        if (params.level !== level) {
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
        console.log('X', verifier.contract_hash.toHex(), isValid);
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
    // let frontierVote
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
              verifierInputs.push(
                await this.ctx.get(UnclaimedOutputService).claim(
                  verifier,
                  workerDriver.done.signal,
                ),
              );
            }
          }
        }

        workerDriver.resumeTimer();
        return {
          blockHash: input.block.hash,
          blockTimestamp: input.block.timestamp,
          ...input.block.outputs[input.outputIdx],
        };
      },

      requireFrontierLevel(level) {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        if (frontierLevel === undefined) {
          frontierLevel = level;
        } else {
          if (frontierLevel !== level) {
            // Ingenerable
            throw COMPUTE_INGENERABLE_FLAG;
          }
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
          const wait = Number(timestampGte) - Date.now();
          if (wait > 0) {
            await new Promise((resolve) => setTimeout(resolve, wait));
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
        console.log(workerDriver.log);
      },
    };
  }

  private areOutputsEqual(a: BlockOutput, b: BlockOutput) {
    return Hash.equals(a.verifier.contract_hash, b.verifier.contract_hash) &&
      arrEquals(a.verifier.params, b.verifier.params) &&
      a.amount === b.amount &&
      arrEquals(a.detail, b.detail);
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
      const publishAt = Date.now() + publishDelay;

      const fact = this.ctx.get(FactService).ingest(
        this.ctx.get(FactService).compose(block, Block, FactType.Block),
        FactSource.Local,
        this.ctx.get(NodeService).getSelfNode(),
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

      return;
    }

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
          this.ctx.get(WorkerLauncherService)
            .enqueueVerification(block, verifier, [CollateralHint.encode({
              hint: { CollateralHintVerifier: { input_idx: i } },
            })], 0);
        }
      }
    }

    if (this.isImmediatelyVerifiable(block) !== true) {
      this.ctx.get(LitigationService).litigate(block, [], 'VALID_CHALLENGE');
    }
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
    return {
      extraContractIncentive: this.extraContractIncentive,
      extraGeneratorIncentive: this.extraGeneratorIncentive,
    };
  }
}
