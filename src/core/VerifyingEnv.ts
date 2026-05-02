// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import { RECORD_CONTRACT } from './Block.ts';
import {
  type ContractEnv,
  ContractRejection,
  ExecutionMode,
  type Input,
  type VerifyingEnvProvider,
} from './ContractEnv.ts';
import type { OutputSlot } from './GeneratingEnv.ts';

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
  private readonly _refs: Hash[];
  private readonly _provider: VerifyingEnvProvider<BlockType>;
  private readonly _signer: Uint8Array | undefined;
  private readonly _timestamp: number;

  /** Tracks which matching inputs have been consumed by requireInput(). */
  private _inputCursor = 0;
  private _matchingInputs: Input[] | null = null;

  /**
   * Per-contract cursor into block.outputs, indexed by the output's
   * `verifier.contract`. Increments each time requireOutput / getOutput
   * consumes a slot for that contract. Enables positional matching
   * within a namespace (see docs/protocol/computation.md#output-namespaces).
   */
  private readonly _namespaceCursor = new Map<HashPrimitive, number>();

  /**
   * Slots this contract emitted during the run, in call order. Used by
   * the block-level namespace partition check to compare against the
   * actual block layout.
   */
  private readonly _emittedSlots: OutputSlot[] = [];

  constructor(opts: {
    contractHash: Hash;
    params: Uint8Array;
    block: BlockType;
    outputs: Output[];
    claims: number[];
    refs: Hash[];
    provider: VerifyingEnvProvider<BlockType>;
    signer?: Uint8Array;
    timestamp?: number;
  }) {
    this._contractHash = opts.contractHash;
    this._params = opts.params;
    this._block = opts.block;
    this._outputs = opts.outputs;
    this._claims = opts.claims;
    this._refs = opts.refs;
    this._provider = opts.provider;
    this._signer = opts.signer;
    this._timestamp = opts.timestamp ?? 0;
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

  requireOutput(verifier: Verifier, value: number, data?: Uint8Array): void {
    const dataBytes = data ?? new Uint8Array(0);
    const slot = this._consumeNextInNamespace(verifier.contract);
    if (slot.data === null) {
      // Null-data outputs are host-only and must live in unowned namespaces.
      // Hitting one here means the contract's namespace contains a slot it
      // couldn't have emitted.
      throw new ContractRejection(
        'required output has null data at namespace slot',
      );
    }
    if (!verifierEquals(slot.verifier, verifier)) {
      throw new ContractRejection(
        'required output verifier mismatch at namespace slot',
      );
    }
    if (slot.value !== value) {
      throw new ContractRejection(
        'required output value mismatch at namespace slot',
      );
    }
    if (!bytesEqual(slot.data, dataBytes)) {
      throw new ContractRejection(
        'required output data mismatch at namespace slot',
      );
    }
    this._emittedSlots.push({
      output: { verifier, value, data: dataBytes },
      origin: 'require',
    });
  }

  getOutput(verifier: Verifier): { value: number; data: Uint8Array } {
    const slot = this._consumeNextInNamespace(verifier.contract);
    if (slot.data === null) {
      throw new ContractRejection(
        'getOutput slot has null data at namespace slot',
      );
    }
    if (!verifierEquals(slot.verifier, verifier)) {
      throw new ContractRejection(
        'getOutput verifier mismatch at namespace slot',
      );
    }
    this._emittedSlots.push({
      output: { verifier: slot.verifier, value: slot.value, data: slot.data },
      origin: 'get',
    });
    return { value: slot.value, data: slot.data };
  }

  requireResult(key: Uint8Array, value: Uint8Array): void {
    // Sugar over requireOutput for RECORD_CONTRACT outputs. Matches positionally
    // within the RECORD_CONTRACT namespace (value = 0 for records).
    this.requireOutput({ contract: RECORD_CONTRACT, params: key }, 0, value);
  }

  fetch(verifier: Verifier, key: Uint8Array): Uint8Array {
    // Find the first ref block that claims the given verifier
    for (const refHash of this._refs) {
      const refBlock = this._provider.getBlock(refHash);
      if (!refBlock) continue;

      // Check if this ref block claims an output matching the verifier
      const refClaims = this._provider.getClaims(refBlock);

      let claimsVerifier = false;
      for (const claimIdx of refClaims) {
        const claimed = this._provider.resolveClaim(refBlock, claimIdx);
        if (claimed && verifierEquals(claimed.verifier, verifier)) {
          claimsVerifier = true;
          break;
        }
      }
      if (!claimsVerifier) continue;

      // Found a ref that claims the verifier -- now read the result
      const refOutputs = this._provider.getOutputs(refBlock);
      for (const output of refOutputs) {
        if (output.data === null) continue;
        if (
          Hash.equals(output.verifier.contract, RECORD_CONTRACT) &&
          bytesEqual(output.verifier.params, key)
        ) {
          return output.data;
        }
      }
      // Ref claims the verifier but has no matching result key
      throw new ContractRejection(`ref block claims verifier but has no result for key`);
    }
    throw new ContractRejection(`no ref block found claiming verifier`);
  }

  requireSignature(pubkey: Uint8Array): void {
    if (!this._signer) {
      throw new ContractRejection('block is not signed');
    }
    if (!bytesEqual(this._signer, pubkey)) {
      throw new ContractRejection('block signer does not match required public key');
    }
  }

  getTimestamp(): number {
    return this._timestamp;
  }

  /**
   * The slots this contract emitted during verification (requireOutput +
   * getOutput calls). Used by the block-level namespace partition check.
   */
  getEmittedSlots(): OutputSlot[] {
    return this._emittedSlots;
  }

  // -- Private ----------------------------------------------------

  /**
   * Consume and return the next block output under the given namespace
   * (matching `verifier.contract`). Throws ContractRejection if the
   * namespace is exhausted.
   */
  private _consumeNextInNamespace(namespace: Hash): Output {
    const key = namespace.toPrimitive();
    const cursor = this._namespaceCursor.get(key) ?? 0;
    // Find the Nth output whose verifier.contract equals `namespace`.
    let count = 0;
    for (const output of this._outputs) {
      if (!Hash.equals(output.verifier.contract, namespace)) continue;
      if (count === cursor) {
        this._namespaceCursor.set(key, cursor + 1);
        return output;
      }
      count++;
    }
    throw new ContractRejection(
      'namespace slot exhausted: contract requested more outputs than the block has',
    );
  }

  /** Lazily compute and cache inputs matching this contract's verifier. */
  private _getMatchingInputs(): Input[] {
    if (this._matchingInputs !== null) return this._matchingInputs;

    const thisVerifier: Verifier = {
      contract: this._contractHash,
      params: this._params,
    };

    const inputs: Input[] = [];
    for (const claimIdx of this._claims) {
      const output = this._provider.resolveClaim(this._block, claimIdx);
      if (!output) continue;
      // Null-data outputs are pure incentive -- invisible to contracts.
      if (output.data === null) continue;
      if (verifierEquals(output.verifier, thisVerifier)) {
        inputs.push({
          verifier: output.verifier,
          value: output.value,
          data: output.data,
          isSelfClaim: claimIdx < this._outputs.length,
        });
      }
    }

    this._matchingInputs = inputs;
    return inputs;
  }
}
