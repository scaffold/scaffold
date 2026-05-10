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
import type { ClaimRef } from './Node.ts';

// -- Types --------------------------------------------------------

/**
 * A generated output paired with its origin. The origin tag is not on
 * the wire -- it's used at solidification time to decide which outputs
 * may have their `value` overridden (only 'get' slots can). Also drives
 * positional matching for the output-namespace partition check.
 * See docs/protocol/computation.md#output-namespaces.
 */
export interface OutputSlot {
  readonly output: Output;
  readonly origin: 'require' | 'get';
}

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
 * Callback that the GeneratingEnv calls when claimNext() cannot be
 * satisfied immediately. The ContractGenerator provides this to register
 * the env in the blocked-generator registry.
 *
 * Returns a Promise that resolves with the next available input.
 */
export type WaitForInputFn = (verifier: Verifier) => Promise<AvailableInput>;

/**
 * Callback the GeneratingEnv calls when `requestBody` has no resolver match.
 * Mirrors `WaitForInputFn`: parks the contract and resolves later once a
 * handler produces a result (e.g., after user input arrives).
 */
export type WaitForGetOutputFn = (
  outputVerifier: Verifier,
) => Promise<{ value: number; body: Uint8Array }>;

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
  private readonly _waitForGetOutput?: WaitForGetOutputFn;
  private readonly _signerPubkey: Uint8Array | undefined;

  /**
   * Outputs to add to the draft, in call order, tagged by origin. The
   * order reflects the sequence of `emitOutput` / `record` /
   * `requestBody` calls. Self-claim bookkeeping for record outputs happens
   * downstream at solidification (see NodeContext._solidifyDraft).
   */
  private readonly _slots: OutputSlot[] = [];
  /** Resolved claims from consumed inputs (with provenance). */
  private readonly _claims: ClaimRef[] = [];
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
    /** Optional callback for blocking claimNext(). If not provided, throws on no input. */
    waitForInput?: WaitForInputFn;
    /** Optional callback for blocking requestBody(). If not provided, throws on no handler match. */
    waitForGetOutput?: WaitForGetOutputFn;
    /**
     * The node's own public key, used to answer `sign` in
     * generation mode: the draft will be signed by this key at
     * solidification, so any `sign(pk)` call reduces to
     * "does `pk === signerPubkey`?". If undefined, any signature
     * requirement rejects.
     */
    signerPubkey?: Uint8Array;
  }) {
    this._contractHash = opts.contractHash;
    this._params = opts.params;
    this._provider = opts.provider;
    this._waitForInput = opts.waitForInput;
    this._waitForGetOutput = opts.waitForGetOutput;
    this._signerPubkey = opts.signerPubkey;
  }

  contractHash(): Hash {
    return this._contractHash;
  }

  params(): Uint8Array {
    return this._params;
  }

  claimAll(): MaybePromise<Input[]> {
    const verifier: Verifier = { contract: this._contractHash, params: this._params };
    return maybeThen(this._provider.findInputs(verifier), (available) => {
      // `findInputs` is expected to already drop data-less outputs (pure
      // incentive, invisible to contracts). AvailableInput.body is always defined.
      for (const ai of available) {
        this._claims.push({
          producer: ai.block,
          outputIndex: ai.outputIndex,
        });
        this._inputs.push({
          verifier: ai.verifier,
          value: ai.value,
          body: ai.body,
          isSelfClaim: false,
        });
        this._addIncludeConstraint(ai.block);
      }
      return this._inputs.slice(-available.length);
    });
  }

  claimNext(): MaybePromise<Input> {
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
    // `findInputs` is expected to drop data-less outputs already.
    // Filter out inputs already consumed in this generation run.
    const unconsumed = available.filter((ai) =>
      !this._claims.some((c) =>
        Hash.equals(c.producer, ai.block) && c.outputIndex === ai.outputIndex
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

  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void {
    this._slots.push({
      output: { verifier, value, body: body ?? new Uint8Array(0) },
      origin: 'require',
    });
  }

  async requestBody(
    verifier: Verifier,
  ): Promise<{ value: number; body: Uint8Array }> {
    let resolved = await this._provider.resolveGetOutput(
      this._contractHash,
      this._params,
      verifier,
    );
    if (resolved === null) {
      if (!this._waitForGetOutput) {
        throw new ContractRejection(
          'no requestBody handler matched (and no wait callback configured)',
        );
      }
      resolved = await this._waitForGetOutput(verifier);
    }
    this._slots.push({
      output: { verifier, value: resolved.value, body: resolved.body },
      origin: 'get',
    });
    return { value: resolved.value, body: resolved.body };
  }

  record(key: Uint8Array, value: Uint8Array): void {
    this._slots.push({
      output: {
        verifier: { contract: RECORD_CONTRACT, params: key },
        value: 0,
        body: value,
      },
      origin: 'require',
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
        if (output.body === undefined) continue;
        if (
          Hash.equals(output.verifier.contract, RECORD_CONTRACT) &&
          bytesEqual(output.verifier.params, key)
        ) {
          return output.body;
        }
      }
      throw new ContractRejection('block claims verifier but has no result for key');
    });
  }

  sign(pubkey: Uint8Array): void {
    // The draft will be signed at solidification by the node's own key.
    // A contract asking for a signature from some other pubkey cannot be
    // satisfied here -- reject so the generator aborts (and the block is
    // never produced on this node). Only the node that actually holds the
    // private key for `pubkey` can produce a block that satisfies this
    // requirement at verification time.
    if (!this._signerPubkey) {
      throw new ContractRejection('signature required but no signer pubkey configured');
    }
    if (!bytesEqual(this._signerPubkey, pubkey)) {
      throw new ContractRejection('signature requirement not met: signer pubkey mismatch');
    }
  }

  timestamp(): number {
    return Date.now();
  }

  // -- Internal helpers --------------------------------------------

  private _consumeInput(ai: AvailableInput): Input {
    this._claims.push({
      producer: ai.block,
      outputIndex: ai.outputIndex,
    });
    const input: Input = {
      verifier: ai.verifier,
      value: ai.value,
      body: ai.body,
      isSelfClaim: false,
    };
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

  /**
   * All outputs the contract wants to produce, in call order. For
   * backward compatibility this returns bare `Output[]`; callers that
   * need origin tags should use `getGeneratedOutputSlots()`.
   */
  getAllOutputs(): Output[] {
    return this._slots.map((s) => s.output);
  }

  /** All output slots with origin tags, in call order. */
  getGeneratedOutputSlots(): OutputSlot[] {
    return this._slots;
  }

  /** Get the inputs consumed by this contract. */
  getConsumedInputs(): Input[] {
    return this._inputs;
  }

  /**
   * Direct (producer, outputIndex) refs for every input the contract
   * consumed during this run. Used by the generation harness to
   * populate / merge into the draft's `claims`. Value is not carried
   * here -- consumers look it up from the producer in the store.
   */
  getClaims(): ClaimRef[] {
    return this._claims;
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
