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
export interface Claim {
  readonly verifier: Verifier;
  readonly value: number;
  readonly body: Uint8Array;
  /** True when the claimed output belongs to the same block that is claiming it. */
  readonly isSelfClaim: boolean;
}

/** An input with its provenance -- where it lives in the DAG. */
export interface AvailableClaim extends Claim {
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
  contractHash(): Hash;

  /**
   * Read an output from the contract's own block (the block whose hash
   * is `env.contractHash()`).
   *
   * Like `requestBody`, but operates on the contract block instead of
   * the executing block, and is purely read-only (no slot is emitted).
   * Used for retrieving record outputs baked into the contract definition:
   * `output_namespaces`, `abi_version`, `max_memory_pages`, source bytes for
   * interpreter-stack contracts, and any other contract-level metadata.
   * See docs/protocol/wasm-abi.md#block-level-contract-metadata.
   *
   * Determinism: the contract block is content-addressed and immutable,
   * so all peers observe identical outputs. The contract block must be
   * loaded locally; if WASM is loaded, the block is loaded.
   *
   * Throws ContractRejection if the contract block is not loaded or if
   * no output matching the verifier exists on it.
   */
  contractMetadata(
    verifier: Verifier,
  ): MaybePromise<{ value: number; body: Uint8Array }>;

  /** The verifier params for this invocation. */
  params(): Uint8Array;

  /**
   * Return all inputs (claimed outputs) matching this contract's verifier.
   * TODO: Inputs should ALWAYS be returned in causal order. This order should match the claim indices of each generated claim.
   *
   * Verification: synchronous, returns matching claims from the block.
   * Generation: possibly async, queries available outputs from UTXO index.
   */
  claimAll(limit?: number): MaybePromise<Claim[]>;

  /**
   * Claim one input matching this contract's verifier.
   * TODO: Inputs should ALWAYS be returned in causal order. This order should match the claim indices of each generated claim.
   *
   * Verification: returns the next unclaimed matching input; throws if none.
   * Generation: finds/waits for an input; adds it as a resolved claim.
   */
  claimNext(): MaybePromise<Claim>;

  /**
   * Require the block to produce a specific output.
   *
   * Verification: checks the next output in the contract's namespace
   * sequence matches exactly (verifier + value + body). The contract's
   * own call order determines the namespace's expected sequence.
   * Generation: adds the output to the draft with `origin: 'require'`.
   *
   * See docs/protocol/computation.md#output-namespaces.
   *
   * TODO(@joel): consider unifying emitOutput + requestBody into a
   * single method that varies by argument count:
   *   emitOutput(verifier, body?, value?): Promise<{value, body}>
   *     (verifier, body, value) -- today's emitOutput
   *     (verifier, body)        -- contract supplies body; host supplies value
   *     (verifier)              -- host supplies both
   * Revisit once more real contracts exercise requestBody.
   */
  emitOutput(verifier: Verifier, value: number, body?: Uint8Array): void;

  /**
   * Ask the host for an output under the given verifier. The host (in
   * generation) or the wire (in verification) supplies `(value, body)`.
   *
   * Generation: the host handler chain synthesizes the output. If no
   * handler matches, the contract blocks until one does (like
   * `claimNext`). Returns `{value, body}` so the contract can use
   * them in downstream logic.
   *
   * Verification: reads the next output in the contract's namespace
   * sequence. `verifier` and `body` must match exactly; `value` on the
   * wire must be `>=` what was emitted at generation time
   * (solidification may raise `value` but not lower it).
   *
   * See docs/protocol/computation.md#output-requirements.
   */
  requestBody(
    verifier: Verifier,
  ): MaybePromise<{ value: number; body: Uint8Array }>;

  /**
   * Self-claimed key-value output on this block.
   * Sugar over emitOutput for `{ contract: RECORD_CONTRACT, params: key, body: value }` slots.
   *
   * Verification: checks the result output exists with the expected value.
   * Generation: creates the result output and self-claim.
   */
  record(key: Uint8Array, value: Uint8Array): void;

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
   * Spawn an independent sub-contract in a new generation context.
   *
   * Verification: no-op. The sub-contract's block is independently verified.
   *
   * Generation: spawns a generator with `verifier` as its identity. The
   * sub-contract has its own ContractEnv and its own block. `records`
   * is a pre-resolved set of `requestBody` answers: when the sub-contract
   * calls `requestBody(v)`, the runtime first scans `records` by
   * verifier-equality and, if matched, returns that `(value, body)` and
   * emits an output slot on the sub-contract's block (so verification
   * needs nothing beyond the block itself).
   *
   * Blocking. Returns once the sub-block has committed. If the
   * sub-generator throws `ContractRejection`, this call propagates the
   * rejection to the parent generator.
   *
   * Auto-emergence. If the sub-contract claims no inputs and no UTXO
   * exists matching `verifier`, the runtime self-claims a new output
   * under `verifier` on the sub-contract's block, so the verifier
   * becomes a UTXO source on the network. If a matching UTXO already
   * exists, it is consumed instead and no new UTXO is created — the
   * data is stored exactly once.
   *
   * See docs/protocol/wasm-abi.md#put.
   */
  put(verifier: Verifier, records: Output[]): MaybePromise<void>;

  /**
   * Assert the block's signature matches the given public key.
   * Throws ContractRejection if not.
   */
  sign(pubkey: Uint8Array): void;

  /**
   * Return the current block's timestamp (milliseconds since epoch).
   *
   * Verification: returns the block's wire-format timestamp.
   * Generation: returns the draft's timestamp or Date.now().
   */
  timestamp(): number;
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
  /**
   * Resolve a claim index in `block`'s extended vector to the
   * concrete `Output` that index points at.
   *
   * The extended vector is `own ++ aggregate.new ++ output_space(anchor)`
   * (see docs/protocol/output-space.md, AGENTS.md). Implementations should
   * delegate to `OutputSpaceModule.resolveClaimIndex` rather than
   * reconstructing the array; flat-array interpretations get aggregation
   * and self-claim handling subtly wrong (see git log for the chess
   * agg-block UTXO bug).
   *
   * Returns `undefined` if the index is out of range or the producing
   * block isn't loaded.
   */
  resolveClaim(block: BlockType, claimIndex: number): Output | undefined;
  getRefs(block: BlockType): Hash[];
}

/**
 * Additional capabilities for GeneratingEnv. Internal -- not exposed to contracts.
 */
export interface GeneratingEnvProvider<BlockType> extends VerifyingEnvProvider<BlockType> {
  /** Find available inputs matching a verifier (with provenance). */
  findInputs(verifier: Verifier): MaybePromise<AvailableClaim[]>;
  /** Find a block that claims the given verifier. Returns its hash. */
  findBlockClaiming(verifier: Verifier): MaybePromise<Hash | undefined>;
  /**
   * Synthesize a `(value, data)` pair for a `requestBody` request. Returns
   * `null` to indicate the handler chain found nothing; the contract then
   * blocks on restart-on-uncanonical. See `OutputHandlerRegistry`.
   */
  resolveGetOutput(
    runningContract: Hash,
    runningParams: Uint8Array,
    outputVerifier: Verifier,
  ): Promise<{ value: number; body: Uint8Array } | null>;
}
