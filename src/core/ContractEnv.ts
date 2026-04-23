// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import { type MaybePromise } from '../util/MaybePromise.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';

// -- Types --------------------------------------------------------

/** Execution mode: generation (building a block) or verification (checking one). */
export enum ExecutionMode {
  Generation = 0,
  Verification = 1,
}

/** A claimed output being consumed as input by a contract. */
export interface Input {
  readonly verifier: Verifier;
  readonly value: number;
  readonly data: Uint8Array;
  /** True when the claimed output belongs to the same block that is claiming it. */
  readonly isSelfClaim: boolean;
}

/** An input with its provenance -- where it lives in the DAG. */
export interface AvailableInput extends Input {
  /** Block containing this output. */
  readonly block: Hash;
  /** Index into that block's output array. */
  readonly outputIndex: number;
}

/**
 * Thrown by a contract to reject the spending condition.
 * Normal return = accept; throwing ContractRejection = reject.
 */
export class ContractRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractRejection';
  }
}

// -- ContractEnv --------------------------------------------------

/**
 * The environment presented to a contract function.
 *
 * Each method has dual-mode semantics:
 * - **Verification**: checks that the block matches expectations (synchronous).
 * - **Generation**: builds the block by adding outputs/claims (possibly async).
 *
 * A contract that returns normally has accepted. A contract that throws
 * ContractRejection has rejected. Other thrown errors are treated as crashes.
 */
export interface ContractEnv {
  /** Current execution mode. */
  readonly mode: ExecutionMode;

  /** The contract hash for this invocation. */
  getContractHash(): Hash;

  /** The verifier params for this invocation. */
  getParams(): Uint8Array;

  /**
   * Return all inputs (claimed outputs) matching this contract's verifier.
   *
   * Verification: synchronous, returns matching claims from the block.
   * Generation: possibly async, queries available outputs from UTXO index.
   */
  collectInputs(): MaybePromise<Input[]>;

  /**
   * Claim one input matching this contract's verifier.
   *
   * Verification: returns the next unclaimed matching input; throws if none.
   * Generation: finds/waits for an input; adds it as a resolved claim.
   */
  requireInput(): MaybePromise<Input>;

  /**
   * Require the block to produce a specific output.
   *
   * Verification: checks the next output in the contract's namespace
   * sequence matches exactly (verifier + value + data). The contract's
   * own call order determines the namespace's expected sequence.
   * Generation: adds the output to the draft with `origin: 'require'`.
   *
   * See docs/protocol/computation.md#output-namespaces.
   */
  requireOutput(verifier: Verifier, value: number, data?: Uint8Array): void;

  /**
   * Ask the host for an output under the given verifier. The host (in
   * generation) or the wire (in verification) supplies `(value, data)`.
   *
   * Generation: the host handler chain synthesizes the output. If no
   * handler matches, the contract blocks until one does (like
   * `requireInput`). Returns `{value, data}` so the contract can use
   * them in downstream logic.
   *
   * Verification: reads the next output in the contract's namespace
   * sequence. `verifier` and `data` must match exactly; `value` on the
   * wire must be `>=` what was emitted at generation time
   * (solidification may raise `value` but not lower it).
   *
   * See docs/protocol/computation.md#output-requirements.
   */
  getOutput(
    verifier: Verifier,
  ): MaybePromise<{ value: number; data: Uint8Array }>;

  /**
   * Require a result (self-claimed key-value output) on this block.
   * Creates/checks an output with { contract: RECORD_CONTRACT, params: key, data: value }.
   *
   * Verification: checks the result output exists with the expected value.
   * Generation: creates the result output and self-claim.
   */
  requireResult(key: Uint8Array, value: Uint8Array): void;

  /**
   * Read a result from an ancestor block that claims the given verifier.
   *
   * Finds the first block (in refs for verification, or via search for generation)
   * that claims an output matching the given verifier, adds it to refs,
   * then reads the RECORD_CONTRACT output keyed by `key` from that block.
   *
   * Throws ContractRejection if no matching block is found.
   */
  fetch(verifier: Verifier, key: Uint8Array): MaybePromise<Uint8Array>;

  /**
   * Assert the block's signature matches the given public key.
   * Throws ContractRejection if not.
   */
  requireSignature(pubkey: Uint8Array): void;

  /**
   * Return the current block's timestamp (milliseconds since epoch).
   *
   * Verification: returns the block's wire-format timestamp.
   * Generation: returns the draft's timestamp or Date.now().
   */
  getTimestamp(): number;
}

/** @deprecated Use Contract interface from './Contract.ts' instead. */
export type ContractFn = (env: ContractEnv) => MaybePromise<void>;

// -- Internal providers -------------------------------------------

/**
 * Data access for VerifyingEnv. Internal -- not exposed to contracts.
 */
export interface VerifyingEnvProvider<BlockType> {
  getBlock(hash: Hash): BlockType | undefined;
  getOutputs(block: BlockType): Output[];
  getClaims(block: BlockType): number[];
  getExtendedOutputs(block: BlockType): Output[];
  getRefs(block: BlockType): Hash[];
}

/**
 * Additional capabilities for GeneratingEnv. Internal -- not exposed to contracts.
 */
export interface GeneratingEnvProvider<BlockType> extends VerifyingEnvProvider<BlockType> {
  /** Find available inputs matching a verifier (with provenance). */
  findInputs(verifier: Verifier): MaybePromise<AvailableInput[]>;
  /** Find a block that claims the given verifier. Returns its hash. */
  findBlockClaiming(verifier: Verifier): MaybePromise<Hash | undefined>;
  /**
   * Synthesize a `(value, data)` pair for a `getOutput` request. Returns
   * `null` to indicate the handler chain found nothing; the contract then
   * blocks on restart-on-uncanonical. See `OutputHandlerRegistry`.
   */
  resolveGetOutput(
    runningContract: Hash,
    runningParams: Uint8Array,
    outputVerifier: Verifier,
  ): Promise<{ value: number; data: Uint8Array } | null>;
}
