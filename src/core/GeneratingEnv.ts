// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import { type MaybePromise, maybeThen } from '../util/MaybePromise.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import { RECORD_CONTRACT } from './Block.ts';
import {
  type AvailableInput,
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
  type GeneratingEnvProvider,
  type Input,
} from './ContractEnv.ts';
import { ResolvedClaim } from './BlockDraft.ts';

// -- Helpers ------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// -- Types --------------------------------------------------------

/**
 * Callback that the GeneratingEnv calls when requireInput() cannot be
 * satisfied immediately. The ContractGenerator provides this to register
 * the env in the blocked-generator registry.
 *
 * Returns a Promise that resolves with the next available input.
 */
export type WaitForInputFn = (verifier: Verifier) => Promise<AvailableInput>;

// -- GeneratingEnv ------------------------------------------------

/**
 * ContractEnv implementation for generation mode.
 * Builds up the draft's outputs, claims, and refs as the contract runs.
 */
export class GeneratingEnv<BlockType> implements ContractEnv {
  readonly mode = ExecutionMode.Generation;

  private readonly _contractHash: Hash;
  private readonly _params: Uint8Array;
  private readonly _provider: GeneratingEnvProvider<BlockType>;
  private readonly _waitForInput?: WaitForInputFn;

  /** Outputs to add to the draft. */
  private readonly _outputs: Output[] = [];
  /** Self-claimed result outputs (also added as outputs + claims). */
  private readonly _resultOutputs: Output[] = [];
  /** Resolved claims from consumed inputs (with provenance). */
  private readonly _resolvedClaims: ResolvedClaim[] = [];
  /** Input data returned to the contract (without provenance). */
  private readonly _inputs: Input[] = [];
  /** Block hashes added to refs. */
  private readonly _refs: Hash[] = [];
  /** Block hashes that must be included in the final subtree. */
  private readonly _includeConstraints: Hash[] = [];

  constructor(opts: {
    contractHash: Hash;
    params: Uint8Array;
    provider: GeneratingEnvProvider<BlockType>;
    /** Optional callback for blocking requireInput(). If not provided, throws on no input. */
    waitForInput?: WaitForInputFn;
  }) {
    this._contractHash = opts.contractHash;
    this._params = opts.params;
    this._provider = opts.provider;
    this._waitForInput = opts.waitForInput;
  }

  getContractHash(): Hash {
    return this._contractHash;
  }

  getParams(): Uint8Array {
    return this._params;
  }

  collectInputs(): MaybePromise<Input[]> {
    const verifier: Verifier = { contract: this._contractHash, params: this._params };
    return maybeThen(this._provider.findInputs(verifier), (available) => {
      for (const ai of available) {
        this._resolvedClaims.push({
          block: ai.block,
          outputIndex: ai.outputIndex,
          value: ai.value,
        });
        this._inputs.push({ verifier: ai.verifier, value: ai.value, data: ai.data });
        this._addIncludeConstraint(ai.block);
      }
      return this._inputs.slice(-available.length);
    });
  }

  requireInput(): MaybePromise<Input> {
    const verifier: Verifier = { contract: this._contractHash, params: this._params };
    const findResult = this._provider.findInputs(verifier);

    if (findResult instanceof Promise) {
      return findResult.then((available) => this._pickInput(available, verifier));
    }
    return this._pickInput(findResult, verifier);
  }

  private _pickInput(
    available: AvailableInput[],
    verifier: Verifier,
  ): MaybePromise<Input> {
    // Filter out inputs already consumed in this generation run
    const unconsumed = available.filter((ai) =>
      !this._resolvedClaims.some((rc) =>
        Hash.equals(rc.block, ai.block) && rc.outputIndex === ai.outputIndex
      )
    );
    if (unconsumed.length > 0) {
      return this._consumeInput(unconsumed[0]);
    }

    // No inputs available -- block if we have a wait callback
    if (this._waitForInput) {
      return this._waitForInput(verifier).then((ai) => this._consumeInput(ai));
    }

    // No wait callback -- reject immediately (legacy behavior)
    throw new ContractRejection('no inputs available');
  }

  requireOutput(verifier: Verifier, value: number, data?: Uint8Array): void {
    this._outputs.push({
      verifier,
      value,
      data: data ?? new Uint8Array(0),
    });
  }

  requireResult(key: Uint8Array, value: Uint8Array): void {
    this._resultOutputs.push({
      verifier: { contract: RECORD_CONTRACT, params: key },
      value: 0,
      data: value,
    });
  }

  fetch(verifier: Verifier, key: Uint8Array): MaybePromise<Uint8Array> {
    return maybeThen(this._provider.findBlockClaiming(verifier), (blockHash) => {
      if (!blockHash) {
        throw new ContractRejection('no block found claiming verifier');
      }

      this._refs.push(blockHash);

      const block = this._provider.getBlock(blockHash);
      if (!block) {
        throw new ContractRejection('block not found after lookup');
      }

      const outputs = this._provider.getOutputs(block);
      for (const output of outputs) {
        if (
          Hash.equals(output.verifier.contract, RECORD_CONTRACT) &&
          bytesEqual(output.verifier.params, key)
        ) {
          return output.data;
        }
      }
      throw new ContractRejection('block claims verifier but has no result for key');
    });
  }

  requireSignature(pubkey: Uint8Array): void {
    if (!bytesEqual(this._params, pubkey)) {
      throw new ContractRejection('signature requirement not met');
    }
  }

  getTimestamp(): number {
    return Date.now();
  }

  // -- Internal helpers --------------------------------------------

  private _consumeInput(ai: AvailableInput): Input {
    this._resolvedClaims.push({
      block: ai.block,
      outputIndex: ai.outputIndex,
      value: ai.value,
    });
    const input: Input = { verifier: ai.verifier, value: ai.value, data: ai.data };
    this._inputs.push(input);
    this._addIncludeConstraint(ai.block);
    return input;
  }

  private _addIncludeConstraint(blockHash: Hash): void {
    if (!this._includeConstraints.some((h) => Hash.equals(h, blockHash))) {
      this._includeConstraints.push(blockHash);
    }
  }

  // -- Accessors for the generation harness -------------------------

  /** Get the outputs the contract wants to produce. */
  getGeneratedOutputs(): Output[] {
    return this._outputs;
  }

  /** Get the self-claimed result outputs. */
  getGeneratedResults(): Output[] {
    return this._resultOutputs;
  }

  /** Get all outputs (results + regular) for inclusion in the draft. */
  getAllOutputs(): Output[] {
    return [...this._resultOutputs, ...this._outputs];
  }

  /** Get the inputs consumed by this contract. */
  getConsumedInputs(): Input[] {
    return this._inputs;
  }

  /** Get resolved claims (inputs with provenance) for the draft. */
  getResolvedClaims(): ResolvedClaim[] {
    return this._resolvedClaims;
  }

  /** Get the block hashes added to refs. */
  getGeneratedRefs(): Hash[] {
    return this._refs;
  }

  /** Get the blocks that must be included in the final subtree. */
  getIncludeConstraints(): Hash[] {
    return this._includeConstraints;
  }
}
