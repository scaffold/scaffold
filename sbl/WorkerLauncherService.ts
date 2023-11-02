import secp from './util/secp.ts';
import BlockBuilder, { BlockSpec, InputSpec } from '~/sbl/BlockBuilder.ts';
import BlockService from './BlockService.ts';
import { dataHash, epochHash, generatorHash, rootHash } from './constants.ts';
import Context from './Context.ts';
import WorkerDriverService, { WorkerDriver } from './WorkerDriverService.ts';
import LocalGeneratorService, {
  INGENERABLE_FLAG,
} from './LocalGeneratorService.ts';
import {
  Block,
  BlockOutput,
  EpochInclusionProof,
  Verifier,
} from './messages.ts';
import { bin2str, str2bin } from './pathUtils.ts';
import { arrConcat, arrEquals } from './util/buffer.ts';
import { error, mapEntries, todo } from './util/functional.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import WorkerExecutor from './WorkerExecutor.ts';
import { getOrCreate } from './util/map.ts';
import DataContract from './DataContract.ts';
import LitigationService from './LitigationService.ts';
import SpecialContractManager from './SpecialContractManager.ts';
import Logger from './Logger.ts';
import { BlockFact, FactSource, FactType } from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import ClockService from '~/sbl/ClockService.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import { INTERRUPT_FLAG } from '~/sbl/worker/WorkerChannel.ts';
import FetchService from '~/sbl/FetchService.ts';

export const enum ComputationType {
  Contract,
  Generator,
}
export const enum BurdenOfProof {
  Invalidation, // Used for most things; one hint proving invalidation makes the contract invalid
  Validation, // Used for things like hash inversions; one hint proving validation makes the hash valid
}

export interface ComputationDriver extends WorkerDriver {
  type: ComputationType;

  getContractHash(): Hash;
  getParams(): Uint8Array;
  getHint(): Uint8Array;
  getBody(): Uint8Array; // Only valid if this is a contract
  requireBody(data: Uint8Array): void; // Provide body if generator, require body equals if contract. Fast-path valid if pointer equals getBody().
  requireOutput(output: BlockOutput): void; // Same kind of thing as requireBody
  emitCorrect(): boolean; // Whether to emit a correct answer or not; returns true if contract

  notify(verifier: Verifier): void;
  request(verifier: Verifier): Promise<Uint8Array>; // TODO: fetch?
  // invert(hash: Hash): MaybePromise<Uint8Array>;
  fulfills(block: BlockFact, outputIdx: number): void;

  getInputCount(): number; // Returns the number of inputs matching this contractHash & params. When this is called, the value is fixed, and the return values from getInputDetail() should be fixed.
  getInputDetail(idx: number): MaybePromise<Uint8Array>; // Returns an input detail at an index. The IO always has the same contractHash & params as this contract. If getInputCount() hasn't been called, block until we have another input.

  compareOrder(blockA: Hash, blockB: Hash): number; // Clamps the frontier vote

  setBurdenOfProof(on: BurdenOfProof): void;
  invalidate(): void;
  offsetCanonicality(offset: bigint): void;

  ingenerable(): void; // TODO: Maybe just throw an exception instead?

  // Do we need these?
  // setFrontierLevel(level: number): void;
  // sign(): void;
}

export default class WorkerLauncherService {
  private attemptDupeFraction = Hash.fromFraction(0, 8);

  private extraContractIncentive: Map<HashPrimitive, number> = new Map();
  private extraGeneratorIncentive: Map<HashPrimitive, number> = new Map();

  private secret: Uint8Array;

  constructor(private ctx: Context) {
    this.secret = ctx.config.entropyProvider.randomBytes(32);
  }

  public enqueueVerification(
    block: BlockFact,
    inputIdx: number,
    verifier: Verifier,
    hint: Uint8Array,
    extraIncentive: number,
  ) {
    const runHash = Hash.digestParts(Verifier.encode(verifier), block.body);
    if (this.extraContractIncentive.has(runHash.toPrimitive())) {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraContractIncentive.set(runHash.toPrimitive(), extraIncentive);
    }

    const special = this.ctx.get(SpecialContractManager)
      .getContract(verifier.contract_hash);
    if (special) {
      this.ctx.get(WorkerDriverService).run(
        verifier,
        {},
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
        async (workerDriver) => {
          await workerDriver.setAllocation({});

          const driver = this.makeVerificationDriver(
            block,
            inputIdx,
            verifier,
            hint,
            workerDriver,
          );
          await special.compute(driver);
          await driver.finalize();
        },
      );
    }

    // TODO: Move to SpecialContractManager
    if (Hash.equals(verifier.contract_hash, dataHash)) {
      const hint = new Uint8Array([]);
      const verified = this.ctx.get(DataContract).verify(
        verifier.params,
        block.body,
        hint,
      );
      this.litigateBlockVerifier(block, verifier, verified, hint);
      return;
    }

    const contractBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
      contract_hash: rootHash,
      params: verifier.contract_hash.toBytes(),
    });
    if (contractBlocks.length) {
      const contractCode = contractBlocks[0].body;

      this.ctx.get(WorkerDriverService).run(
        verifier,
        {},
        () => this.extraContractIncentive.get(runHash.toPrimitive())!,
        async (workerDriver) => {
          await workerDriver.setAllocation({});

          const driver = this.makeVerificationDriver(
            block,
            inputIdx,
            verifier,
            hint,
            workerDriver,
          );
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
          await driver.finalize();
        },
      );
    }
  }

  public enqueueGeneration(
    verifier: Verifier,
    detail: Uint8Array | undefined,
    extraIncentive: number,
  ) {
    const runHash = Hash.digest(Verifier.encode(verifier));
    if (this.extraGeneratorIncentive.has(runHash.toPrimitive())) {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
      return;
    } else {
      this.extraGeneratorIncentive.set(runHash.toPrimitive(), extraIncentive);
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
        verifier,
        {},
        getScore,
        async (workerDriver) => {
          await workerDriver.setAllocation({});

          const driver = this.makeGenerationDriver(verifier, workerDriver);
          try {
            await localGenerator(driver, this.ctx);
            await driver.finalize();
          } catch (err) {
            if (err !== INGENERABLE_FLAG) {
              throw err;
            }
          }
        },
      );
    } else {
      const generatorBlocks = this.ctx.get(BlockService).getBlocksByVerifier({
        contract_hash: generatorHash,
        params: verifier.contract_hash.toBytes(),
      });
      if (generatorBlocks.length) {
        const generatorCode = generatorBlocks[0].body;

        this.ctx.get(WorkerDriverService).run(
          verifier,
          {},
          getScore,
          async (workerDriver) => {
            await workerDriver.setAllocation({ webWorkerCount: 1 });

            const driver = this.makeGenerationDriver(verifier, workerDriver);
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
              await driver.finalize();
            } catch (err) {
              if (err !== INGENERABLE_FLAG) {
                throw err;
              }
            }
          },
        );
      }
    }
  }

  private makeVerificationDriver(
    block: BlockFact,
    inputIdx: number,
    verifier: Verifier,
    hint: Uint8Array,
    workerDriver: WorkerDriver,
  ): ComputationDriver & { finalize(): MaybePromise<void> } {
    let burdenOfProof = BurdenOfProof.Invalidation;

    let nextRefIdx = 0;
    let nextOutputIdx = 0;

    // Do litigation in here

    return {
      ...workerDriver,

      type: ComputationType.Generator,

      getContractHash: () => verifier.contract_hash,
      getParams: () => verifier.params,
      getHint: () => hint,
      getBody: () => block.body,
      requireBody: (data) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        if (!arrEquals(block.body, data)) {
          this.ctx.get(LitigationService).litigateBlock(block, {
            ClaimVerificationFailed: { input_idx: inputIdx, hint },
          });
          block.passedVerification = false;
          workerDriver.done.abort();
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
        this.ctx.get(LitigationService).litigateBlock(block, {
          ClaimVerificationFailed: { input_idx: inputIdx, hint },
        });
        block.passedVerification = false;
        workerDriver.done.abort();
      },
      emitCorrect: () => true,

      notify: (_verifier) => {},
      request: async (verifier) => {
        // Check all refs asynchronously; if we match on one, cancel the others
        while (nextRefIdx !== block.refs.length) {
          const candidate = block.refs[nextRefIdx++];
          const ref = await this.ctx.get(BlockService).waitForBlock(
            candidate,
            workerDriver.done.signal,
          );
        }
      },

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
      getInputDetail: async (idx: number) => {
        if (inputsAreFixed) {
          const input = verifierInputs[idx];
          if (input === undefined) {
            throw new Error(`Invalid index!`);
          }
          return input.block.outputs[input.outputIdx].detail;
        } else {
          while (true) {
            const input = verifierInputs[idx];
            if (input !== undefined) {
              return input.block.outputs[input.outputIdx].detail;
            } else {
              verifierInputs.push(
                await this.ctx.get(BlockService).claimOutput(verifier),
              );
            }
          }
        }
      },

      ingenerable: () => {
        throw new Error(`Cannot call ingenerable() from a contract!`);
      },

      finalize: () => {
        todo();
      },
    };

    // getContractHash(): Hash;
    // getParams(): Uint8Array;
    // getBody(): Uint8Array; // Only valid if this is a contract
    // requireBody(data: Uint8Array): void; // Provide body if generator, require body equals if contract. Fast-path valid if pointer equals getBody().
    // requireOutput(output: BlockOutput): void; // Same kind of thing as requireBody
    // emitCorrect(): boolean; // Whether to emit a correct answer or not; returns true if contract

    // request(verifier: Verifier): Promise<Uint8Array>; // TODO: fetch?
    // notify(verifier: Verifier): void;
    // fulfills(block: BlockFact, outputIdx: number): void;

    // getInputCount(): number; // Returns the number of inputs matching this contractHash & params. When this is called, the value is fixed, and the return values from getInputDetail() should be fixed.
    // getInputDetail(idx: number): MaybePromise<Uint8Array>; // Returns an input detail at an index. The IO always has the same contractHash & params as this contract. If getInputCount() hasn't been called, block until we have another input.

    // compareOrder(blockA: Hash, blockB: Hash): number; // Clamps the frontier vote

    // setBurdenOfProof(on: BurdenOfProof): void;
    // invalidate(): void;
    // offsetCanonicality(offset: bigint): void;

    // // Used by the driver service
    // getBlockSpec(): BlockSpec;
    // finalize(): MaybePromise<void>;
  }

  private makeGenerationDriver(
    verifier: Verifier,
    workerDriver: WorkerDriver,
  ): ComputationDriver & { finalize(): MaybePromise<void> } {
    let burdenOfProof = BurdenOfProof.Invalidation;

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
            throw INGENERABLE_FLAG;
          }
        }
      },
      requireOutput: (output: BlockOutput) => {
        if (workerDriver.done.signal.aborted) {
          return;
        }
        outputs.push(output);
      },
      emitCorrect: () => {
        if (emitCorrect === undefined) {
          emitCorrect = this.shouldEmitCorrect(verifier);
        }
        return emitCorrect;
      },

      notify: (verifier) => this.ctx.get(FetchService).fetch(verifier, {}),
      request: (verifier) =>
        new Promise((reply) => {
          if (workerDriver.done.signal.aborted) {
            return;
          }

          // TODO: Call pause/resume when requesting?
          const idx = refs.length;
          const { release } = this.ctx.get(FetchService).fetch(
            verifier,
            {},
            (block) => {
              this.ctx.get(Logger).info('got req', { verifier, block });

              // TODO: If we get a non-canonical block (canonicality <= 0), we have to check if it's mergeable with the other inputs (positive and negative).
              // If it's not, or maybe just in any case of not having a canonical input:
              //   Any block can be made canonical by re-writing, and not claiming the disputed input(s).

              if (refs.length === idx) {
                refs.push(block);
                reply(block.body);
              } else if (arrEquals(refs[idx].body, block.body)) {
                // TODO: What to do here?
                refs[idx] = block;
              } else {
                workerDriver.cancel(INTERRUPT_FLAG);

                // TODO: Remove our entries from workerQueue, which will make them never resolve
              }
            },
          );
          workerDriver.onCleanup(release);
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
      getInputDetail: async (idx: number) => {
        if (inputsAreFixed) {
          const input = verifierInputs[idx];
          if (input === undefined) {
            throw new Error(`Invalid index!`);
          }
          return input.block.outputs[input.outputIdx].detail;
        } else {
          while (true) {
            const input = verifierInputs[idx];
            if (input !== undefined) {
              return input.block.outputs[input.outputIdx].detail;
            } else {
              verifierInputs.push(
                await this.ctx.get(BlockService).waitForUnclaimedOutput(
                  verifier,
                  workerDriver.done.signal,
                ),
              );
            }
          }
        }
      },

      ingenerable: () => {
        throw INGENERABLE_FLAG;
      },

      finalize: () => {
        // If this property was never retrieved, we can assume the generator created a correct block.
        const isCorrect = emitCorrect ?? true;

        const blockSpec: BlockSpec = {
          refs,
          inputs: [...verifierInputs, ...otherInputs],
          satisfies: inputsAreFixed ? undefined : [verifier],
          outputs,
          body,
          frontierLevel,
        };

        return this.createBlock(verifier, blockSpec, 0);
      },
    };

    // getContractHash(): Hash;
    // getParams(): Uint8Array;
    // getBody(): Uint8Array; // Only valid if this is a contract
    // requireBody(data: Uint8Array): void; // Provide body if generator, require body equals if contract. Fast-path valid if pointer equals getBody().
    // requireOutput(output: BlockOutput): void; // Same kind of thing as requireBody
    // emitCorrect(): boolean; // Whether to emit a correct answer or not; returns true if contract

    // request(verifier: Verifier): Promise<Uint8Array>; // TODO: fetch?
    // notify(verifier: Verifier): void;
    // fulfills(block: BlockFact, outputIdx: number): void;

    // getInputCount(): number; // Returns the number of inputs matching this contractHash & params. When this is called, the value is fixed, and the return values from getInputDetail() should be fixed.
    // getInputDetail(idx: number): MaybePromise<Uint8Array>; // Returns an input detail at an index. The IO always has the same contractHash & params as this contract. If getInputCount() hasn't been called, block until we have another input.

    // compareOrder(blockA: Hash, blockB: Hash): number; // Clamps the frontier vote

    // setBurdenOfProof(on: BurdenOfProof): void;
    // invalidate(): void;
    // offsetCanonicality(offset: bigint): void;

    // // Used by the driver service
    // getBlockSpec(): BlockSpec;
    // finalize(): MaybePromise<void>;
  }

  private areOutputsEqual(a: BlockOutput, b: BlockOutput) {
    return Hash.equals(a.verifier.contract_hash, b.verifier.contract_hash) &&
      arrEquals(a.verifier.params, b.verifier.params) &&
      a.amount === b.amount &&
      arrEquals(a.detail, b.detail);
  }

  private shouldEmitCorrect(verifier: Verifier) {
    return Hash.cmp(
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
      this.enqueueVerification(block, verifier, 0);
    } else {
      this.ctx.get(LitigationService).litigateBlock(block, {
        ClaimAllValid: {},
      });
    }
  }

  private litigateBlockVerifier(
    block: BlockFact,
    verifier: Verifier,
    isValid: boolean,
    hint: Uint8Array = new Uint8Array(),
  ) {
    const idx = block.inputs.findIndex((input) => {
      const fact = this.ctx.get(FactService).get(input.block_hash);
      if (fact !== undefined && fact.type === FactType.Block) {
        const v2 = fact.outputs[input.output_idx].verifier;
        return Hash.equals(v2.contract_hash, verifier.contract_hash) &&
          arrEquals(v2.params, verifier.params);
      }
    });
    if (idx === -1) {
      throw new Error(
        `Cannot find block input with correct verifier for litigation!`,
      );
    }

    if (isValid) {
      this.ctx.get(LitigationService).litigateBlock(block, {
        ClaimVerificationPassed: { input_idx: idx, hint },
      });
    } else {
      this.ctx.get(LitigationService).litigateBlock(block, {
        ClaimVerificationFailed: { input_idx: idx, hint },
      });
    }
  }

  public snapshot() {
    return {
      extraContractIncentive: this.extraContractIncentive,
      extraGeneratorIncentive: this.extraGeneratorIncentive,
    };
  }
}
