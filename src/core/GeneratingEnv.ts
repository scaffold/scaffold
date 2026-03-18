// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import { type MaybePromise, maybeThen } from '../util/MaybePromise.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import { RESULT_CONTRACT } from './Block.ts';
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

  constructor(opts: {
    contractHash: Hash;
    params: Uint8Array;
    provider: GeneratingEnvProvider<BlockType>;
  }) {
    this._contractHash = opts.contractHash;
    this._params = opts.params;
    this._provider = opts.provider;
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
        this._inputs.push({ verifier: ai.verifier, value: ai.value, detail: ai.detail });
      }
      return this._inputs.slice(-available.length);
    });
  }

  requireInput(): MaybePromise<Input> {
    const verifier: Verifier = { contract: this._contractHash, params: this._params };
    return maybeThen(this._provider.findInputs(verifier), (available) => {
      if (available.length === 0) {
        throw new ContractRejection('no inputs available');
      }
      const ai = available[0];
      this._resolvedClaims.push({
        block: ai.block,
        outputIndex: ai.outputIndex,
        value: ai.value,
      });
      const input: Input = { verifier: ai.verifier, value: ai.value, detail: ai.detail };
      this._inputs.push(input);
      return input;
    });
  }

  requireOutput(verifier: Verifier, value: number, detail?: Uint8Array): void {
    this._outputs.push({
      verifier,
      value,
      detail: detail ?? new Uint8Array(0),
    });
  }

  requireResult(key: Uint8Array, value: Uint8Array): void {
    this._resultOutputs.push({
      verifier: { contract: RESULT_CONTRACT, params: key },
      value: 0,
      detail: value,
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
          Hash.equals(output.verifier.contract, RESULT_CONTRACT) &&
          bytesEqual(output.verifier.params, key)
        ) {
          return output.detail;
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
}
