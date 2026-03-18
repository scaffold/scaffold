// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import { RESULT_CONTRACT } from './Block.ts';
import {
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
  type Input,
  type VerifyingEnvProvider,
} from './ContractEnv.ts';

// -- Helpers ------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function verifierEquals(a: Verifier, b: Verifier): boolean {
  return Hash.equals(a.contract, b.contract) && bytesEqual(a.params, b.params);
}

// -- VerifyingEnv -------------------------------------------------

/**
 * ContractEnv implementation for verification mode.
 * All methods are synchronous -- they read from the existing block.
 */
export class VerifyingEnv<BlockType> implements ContractEnv {
  readonly mode = ExecutionMode.Verification;

  private readonly _contractHash: Hash;
  private readonly _params: Uint8Array;
  private readonly _block: BlockType;
  private readonly _outputs: Output[];
  private readonly _claims: number[];
  private readonly _extendedOutputs: Output[];
  private readonly _refs: Hash[];
  private readonly _provider: VerifyingEnvProvider<BlockType>;

  /** Tracks which matching inputs have been consumed by requireInput(). */
  private _inputCursor = 0;
  private _matchingInputs: Input[] | null = null;

  constructor(opts: {
    contractHash: Hash;
    params: Uint8Array;
    block: BlockType;
    outputs: Output[];
    claims: number[];
    extendedOutputs: Output[];
    refs: Hash[];
    provider: VerifyingEnvProvider<BlockType>;
  }) {
    this._contractHash = opts.contractHash;
    this._params = opts.params;
    this._block = opts.block;
    this._outputs = opts.outputs;
    this._claims = opts.claims;
    this._extendedOutputs = opts.extendedOutputs;
    this._refs = opts.refs;
    this._provider = opts.provider;
  }

  getContractHash(): Hash {
    return this._contractHash;
  }

  getParams(): Uint8Array {
    return this._params;
  }

  collectInputs(): Input[] {
    return this._getMatchingInputs();
  }

  requireInput(): Input {
    const inputs = this._getMatchingInputs();
    if (this._inputCursor >= inputs.length) {
      throw new ContractRejection('no more inputs available');
    }
    return inputs[this._inputCursor++];
  }

  requireOutput(verifier: Verifier, value: number, detail?: Uint8Array): void {
    const detailBytes = detail ?? new Uint8Array(0);
    for (const output of this._outputs) {
      if (
        verifierEquals(output.verifier, verifier) &&
        output.value === value &&
        bytesEqual(output.detail, detailBytes)
      ) {
        return;
      }
    }
    throw new ContractRejection('required output not found on block');
  }

  requireResult(key: Uint8Array, value: Uint8Array): void {
    for (const output of this._outputs) {
      if (!Hash.equals(output.verifier.contract, RESULT_CONTRACT)) continue;
      if (!bytesEqual(output.verifier.params, key)) continue;
      if (!bytesEqual(output.detail, value)) {
        throw new ContractRejection(
          `result key has wrong value`,
        );
      }
      return;
    }
    throw new ContractRejection(`result output not found`);
  }

  fetch(verifier: Verifier, key: Uint8Array): Uint8Array {
    // Find the first ref block that claims the given verifier
    for (const refHash of this._refs) {
      const refBlock = this._provider.getBlock(refHash);
      if (!refBlock) continue;

      // Check if this ref block claims an output matching the verifier
      const refClaims = this._provider.getClaims(refBlock);
      const refExtended = this._provider.getExtendedOutputs(refBlock);

      let claimsVerifier = false;
      for (const claimIdx of refClaims) {
        const claimed = refExtended[claimIdx];
        if (claimed && verifierEquals(claimed.verifier, verifier)) {
          claimsVerifier = true;
          break;
        }
      }
      if (!claimsVerifier) continue;

      // Found a ref that claims the verifier -- now read the result
      const refOutputs = this._provider.getOutputs(refBlock);
      for (const output of refOutputs) {
        if (
          Hash.equals(output.verifier.contract, RESULT_CONTRACT) &&
          bytesEqual(output.verifier.params, key)
        ) {
          return output.detail;
        }
      }
      // Ref claims the verifier but has no matching result key
      throw new ContractRejection(`ref block claims verifier but has no result for key`);
    }
    throw new ContractRejection(`no ref block found claiming verifier`);
  }

  requireSignature(pubkey: Uint8Array): void {
    // For now, check that params match the expected pubkey
    // For the mock implementation, check params match the expected pubkey
    if (!bytesEqual(this._params, pubkey)) {
      throw new ContractRejection('signature requirement not met');
    }
  }

  // -- Private ----------------------------------------------------

  /** Lazily compute and cache inputs matching this contract's verifier. */
  private _getMatchingInputs(): Input[] {
    if (this._matchingInputs !== null) return this._matchingInputs;

    const thisVerifier: Verifier = {
      contract: this._contractHash,
      params: this._params,
    };

    const inputs: Input[] = [];
    for (const claimIdx of this._claims) {
      const output = this._extendedOutputs[claimIdx];
      if (!output) continue;
      if (Hash.equals(output.verifier.contract, RESULT_CONTRACT)) continue;
      if (verifierEquals(output.verifier, thisVerifier)) {
        inputs.push({
          verifier: output.verifier,
          value: output.value,
          detail: output.detail,
        });
      }
    }

    this._matchingInputs = inputs;
    return inputs;
  }
}
