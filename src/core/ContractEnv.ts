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
  /**
   * Current execution mode.
   *
   * DIRECTION (see docs/protocol/results.md#mode-becomes-a-function): this is
   * slated to become a method `mode(): ExecutionMode` so the runtime can
   * observe the call and record that a generator branched on mode (and is
   * therefore potentially non-unique). A bare property access cannot be
   * intercepted. The WASM ABI already exposes it as a function. The TS
   * property + its call sites migration is tracked in TODO.md.
   */
  readonly mode: ExecutionMode;

  /** The contract hash for this invocation. */
  contractHash(): Hash;

  /**
   * Read an output from the contract's own block (the block whose hash
   * is `env.contractHash()`).
   *
   * Like `request`, but operates on the contract block instead of
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
   * Produce the answer to this invocation's verifier `V` by *computing* it.
   * Adds a self-claimed, zero-value output `{V, data}` (an "answer"); in
   * verification, checks such an output exists with exactly this `data`.
   *
   * Use when the answer is a pure function of the contract's inputs. The
   * answer-producing analogue of `add_output`. See
   * docs/protocol/results.md#setresultdata-uint8array-void.
   */
  setResult(data: Uint8Array): void;

  /**
   * Produce the answer to this invocation's verifier `V` from *host-supplied*
   * bytes. Commits the bytes as a self-claimed `{V, data}` answer (like
   * `setResult`) AND returns them for the contract to validate. The
   * answer-producing analogue of `get_output`.
   *
   * Source order: (1) the `data` supplied in a `put(V, data)` context;
   * (2) piggyback -- copy a prior answer's data from a trusted block serving
   * `V`; (3) block until a piggybackable block for `V` is ingested.
   *
   * NOTE: `getResult` *commits* -- it is not a read-only input channel. A
   * contract that validates the bytes (e.g. `hash(getResult()) == params`) has
   * thereby published the answer. Context-dependent: a generator that calls
   * this may produce a non-unique result. See docs/protocol/results.md.
   */
  getResult(): MaybePromise<Uint8Array>;

  /**
   * Publish a single output under the given verifier with the supplied
   * body and value. Fire-and-forget within the contract: the slot is
   * appended to the namespace and the call returns nothing.
   *
   * Verification: checks the next output in the contract's namespace
   * sequence matches exactly (verifier + value + body). The contract's
   * own call order determines the namespace's expected sequence.
   * Generation: adds the output to the draft with `origin: 'require'`.
   *
   * Mirrors `Scaffold.send({contract, params, body})` at the contract
   * level. See docs/protocol/computation.md#output-namespaces.
   */
  send(verifier: Verifier, value: number, body?: Uint8Array): void;

  /**
   * Read a result from a block that claims the given verifier, appending
   * that block to `refs` (in call order, interleaved with `put`), then
   * reading the RECORD_CONTRACT output keyed by `key`.
   *
   * Generation: searches for a block claiming the verifier and appends it
   * to refs. Verification: refs are consumed positionally -- each
   * `fetch`/`put` call takes the next ref, and `fetch` checks that ref
   * claims the requested verifier. Because the contract is deterministic,
   * the call order matches generation.
   *
   * Throws ContractRejection if no matching block is found.
   */
  fetch(verifier: Verifier, key: Uint8Array): MaybePromise<Uint8Array>;

  /**
   * Publish a verifier on a new block with fitting records. Resolves with
   * the committed sub-block's hash.
   *
   * Mirrors `Scaffold.put({contract, params, records})` at the contract
   * level. The new block self-claims an output under `verifier` (so it
   * is discoverable via `fetch(verifier, key)`) and emits one
   * RECORD_CONTRACT output per entry in `records`.
   *
   * Generation: spawns a sub-generator with `verifier` as its identity
   * and the supplied `records` as the data the sub-block publishes.
   * Blocking. Resolves with the sub-block's hash once it has committed.
   * The hash is appended to the block's `refs` (interleaved with `fetch`
   * refs, in call order). If the sub-generator throws `ContractRejection`,
   * this call propagates the rejection to the parent generator.
   *
   * Verification: the sub-block is verified independently; here `put`
   * replays its RETURN value by consuming the next entry from the block's
   * `refs` (the same positional cursor `fetch` uses). So a contract whose
   * outputs depend on the returned hash (e.g. one that records it)
   * re-verifies identically -- it is network-verifiable via `fetch`.
   *
   * Auto-emergence. If the sub-contract claims no inputs and no UTXO
   * exists matching `verifier`, the runtime self-claims a new output
   * under `verifier` on the sub-contract's block, so the verifier
   * becomes a UTXO source on the network. If a matching UTXO already
   * exists, it is consumed instead and no new UTXO is created -- the
   * data is stored exactly once.
   *
   * See docs/protocol/wasm-abi.md#put.
   */
  put(verifier: Verifier, data: Uint8Array): MaybePromise<Hash>;

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
   *
   * Context-dependent: leaks wall-clock time into the result, making a
   * generator that uses it non-unique. Prefer `timestampGte` where only a
   * lower bound is needed. Slated for possible removal once decay-window
   * callers migrate. See docs/protocol/results.md#timestampgte-instead-of-timestamp.
   */
  timestamp(): number;

  /**
   * Assert the block's timestamp is at or after `instant` (ms since epoch).
   *
   * Verification: checks `block.timestamp >= instant`, else rejects.
   * Generation: constrains the draft's timestamp to `>= instant`.
   *
   * Unlike `timestamp()`, this asserts a bound rather than leaking the actual
   * time, so it preserves answer uniqueness: the block hash still varies but
   * the answer bytes do not depend on the timestamp. Fulfills most uses of
   * `timestamp()` (decay windows, "not before"). PLANNED -- optional until
   * the impls and callers migrate; see docs/protocol/results.md and TODO.md.
   */
  timestampGte?(instant: number): void;

  /**
   * Diagnostic-only sink. Does NOT emit a scaffold output. Implementations
   * typically forward to `ctx.logger('contract').debug`. Used by the WASI
   * shim's `/out/debug` stream.
   *
   * Optional: callers must tolerate `env.debug === undefined`. The WASM
   * host bridge swallows debug writes silently when the env doesn't
   * implement this method.
   */
  debug?(message: string): void;
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
