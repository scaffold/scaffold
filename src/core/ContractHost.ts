// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { type MaybePromise, maybeThen } from '../util/MaybePromise.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import type { ClaimRef } from './Node.ts';
import type { Contract } from '../contracts/Contract.ts';
import type { ContractPlugin } from './ContractPlugin.ts';
import {
  ContractRejection,
  type GeneratingEnvProvider,
  type VerifyingEnvProvider,
} from './ContractEnv.ts';
import { VerifyingEnv } from './VerifyingEnv.ts';
import {
  GeneratingEnv,
  type OutputSlot,
  type PutFn,
  type WaitForGetOutputFn,
  type WaitForInputFn,
} from './GeneratingEnv.ts';

// -- Re-exports -----------------------------------------------------

export { ExecutionMode } from './ContractEnv.ts';
export type { Contract } from '../contracts/Contract.ts';

// -- Types ----------------------------------------------------------

/** Result of executing a contract for a single claimed output. */
export type ExecutionResult =
  | { accepted: true; emittedSlots?: OutputSlot[] }
  | { accepted: false; reason: string };

/** Inputs to a single verification run. */
export interface VerifyingRunInput<BlockType> {
  readonly block: BlockType;
  readonly verifier: Verifier;
  readonly outputs: Output[];
  readonly claimIndices: number[];
  readonly refs: Hash[];
  readonly signer?: Uint8Array;
  readonly timestamp: number;
}

/** Inputs to a single generation run. */
export interface GeneratingRunInput<BlockType> {
  readonly verifier: Verifier;
  readonly provider: GeneratingEnvProvider<BlockType>;
  readonly waitForInput?: WaitForInputFn;
  readonly waitForGetOutput?: WaitForGetOutputFn;
  /** Optional callback used by `env.put`. Omit to reject any put() call. */
  readonly put?: PutFn;
  /** The node's own pubkey. Used by `sign` in generation mode. */
  readonly signerPubkey?: Uint8Array;
}

/**
 * Result of a generation run -- the env's accumulated state, exposed so
 * callers can merge it into the draft without knowing the env's internals.
 */
export interface GeneratingRunResult<BlockType> {
  readonly outputs: Output[];
  /**
   * Slot-tagged outputs in call order. `origin: 'get'` slots may have
   * their `value` raised at solidification (see
   * docs/protocol/computation.md#output-requirements). Same content as
   * `outputs` -- both kept so callers that don't care about origin can
   * keep using the simpler field.
   */
  readonly outputSlots: OutputSlot[];
  /**
   * Direct (producer, outputIndex) refs for every input the contract
   * consumed. Caller merges these into the draft's `claims`. Value is
   * not carried -- consumers look it up from the producer in the store
   * when needed.
   */
  readonly claims: ClaimRef[];
  readonly refs: Hash[];
  readonly includeConstraints: Hash[];
  /** Exposed so callers can apply the default `claimAll()` if the contract never called inputs-consuming methods. */
  readonly env: GeneratingEnv<BlockType>;
}

// -- ContractHost ----------------------------------------------------

/**
 * Primitive contract execution surface. Holds a contract registry keyed by
 * contract hash and exposes two entry points:
 *
 *   runVerifying -- run a contract in verification mode for a single {block, verifier}
 *   runGenerating -- run a contract in generation mode and return the env's accumulated state
 *
 * The host does not know about blocks-under-verification, claims iteration,
 * scheduling, dedupe, or draft lifecycle. Those live one layer up in
 * BlockVerificationModule / ContractVerificationModule / GenerationModule.
 */
export interface ContractHostConfig<BlockType> {
  /**
   * Block-store lookup used to resolve plugin candidates. When omitted,
   * `getContract` only consults the in-process TS registry (legacy
   * `registerContract` path) and ignores plugins. Production wiring
   * always provides this; unit tests that only register TS contracts
   * directly can omit it.
   */
  getBlock?: (hash: Hash) => BlockType | undefined;
}

export class ContractHost<BlockType> {
  private readonly _contracts = new Map<HashPrimitive, Contract>();
  private readonly _plugins: ContractPlugin<BlockType>[] = [];
  /** Per-hash cache of plugin-resolved contracts so we don't re-walk on every call. */
  private readonly _pluginCache = new Map<HashPrimitive, Contract>();
  private readonly _getBlock?: (hash: Hash) => BlockType | undefined;

  constructor(config: ContractHostConfig<BlockType> = {}) {
    this._getBlock = config.getBlock;
  }

  /**
   * Register a TS-side contract implementation for a contract hash.
   * Built-in contracts (SIGNATURE_CONTRACT, COLLATERAL_CONTRACT, etc.)
   * use this path. On-chain WASM contracts go through plugins instead.
   */
  registerContract(contractHash: Hash, contract: Contract): void {
    this._contracts.set(contractHash.toPrimitive(), contract);
  }

  /**
   * Register a contract execution plugin. Plugins are consulted in
   * registration order for any hash not found in the TS registry. The
   * first plugin that accepts the contract block wins, and its result
   * is cached by hash. See `ContractPlugin`.
   */
  registerPlugin(plugin: ContractPlugin<BlockType>): void {
    this._plugins.push(plugin);
    // Invalidate the cache: a newly-registered plugin may claim hashes
    // that previously fell through. Conservatively flush.
    this._pluginCache.clear();
  }

  /**
   * Look up a `Contract` for `contractHash`. Resolution order:
   *   1. TS registry (`registerContract`).
   *   2. Plugin cache.
   *   3. First plugin whose `accepts(block)` returns true, where `block`
   *      is loaded via `config.getBlock`. Result is cached.
   *
   * Returns `undefined` if no path resolves.
   */
  getContract(contractHash: Hash): Contract | undefined {
    const key = contractHash.toPrimitive();
    const direct = this._contracts.get(key);
    if (direct) return direct;

    const cached = this._pluginCache.get(key);
    if (cached) return cached;

    if (!this._getBlock || this._plugins.length === 0) return undefined;
    const block = this._getBlock(contractHash);
    if (!block) return undefined;

    for (const plugin of this._plugins) {
      if (plugin.accepts(block)) {
        const contract = plugin.getContract(block);
        this._pluginCache.set(key, contract);
        return contract;
      }
    }
    return undefined;
  }

  /**
   * Declared output namespaces for a registered contract. Returns `[]` if
   * the contract is unknown or declares nothing. See
   * docs/protocol/computation.md#output-namespaces.
   */
  getOutputNamespaces(contractHash: Hash): Hash[] {
    return this.getContract(contractHash)?.outputNamespaces ?? [];
  }

  /**
   * Run a contract in verification mode. Returns an ExecutionResult.
   * Never throws for contract-level outcomes -- ContractRejection becomes
   * `{ accepted: false, reason }`, other thrown errors become
   * `{ accepted: false, reason: "contract threw: ..." }`.
   */
  runVerifying(
    input: VerifyingRunInput<BlockType>,
    provider: VerifyingEnvProvider<BlockType>,
  ): MaybePromise<ExecutionResult> {
    const contract = this.getContract(input.verifier.contract);
    if (!contract) {
      return { accepted: false, reason: `contract not found: ${input.verifier.contract.toHex()}` };
    }

    const env = new VerifyingEnv<BlockType>({
      contractHash: input.verifier.contract,
      params: input.verifier.params,
      block: input.block,
      outputs: input.outputs,
      claimIndices: input.claimIndices,
      refs: input.refs,
      provider,
      signer: input.signer,
      timestamp: input.timestamp,
    });

    try {
      const result = contract.run(env);
      if (result instanceof Promise) {
        return result.then(
          () => ({
            accepted: true as const,
            emittedSlots: env.getEmittedSlots(),
          }),
          (e) => toErrorResult(e),
        );
      }
      return {
        accepted: true as const,
        emittedSlots: env.getEmittedSlots(),
      };
    } catch (e) {
      return toErrorResult(e);
    }
  }

  /**
   * Run a contract in generation mode. Returns the env's accumulated state
   * plus the env itself (so callers can invoke `env.claimAll()` post-run
   * as a default when the contract never requested inputs).
   *
   * Throws ContractRejection / other errors up to the caller -- the caller
   * owns the draft lifecycle and decides what to do on rejection.
   */
  runGenerating(
    input: GeneratingRunInput<BlockType>,
  ): MaybePromise<GeneratingRunResult<BlockType>> {
    const contract = this.getContract(input.verifier.contract);
    if (!contract) {
      throw new ContractRejection(`contract not found: ${input.verifier.contract.toHex()}`);
    }

    const env = new GeneratingEnv<BlockType>({
      contractHash: input.verifier.contract,
      params: input.verifier.params,
      provider: input.provider,
      waitForInput: input.waitForInput,
      waitForGetOutput: input.waitForGetOutput,
      put: input.put,
      signerPubkey: input.signerPubkey,
    });

    const result = contract.run(env);
    return maybeThen(result, () => ({
      outputs: env.getAllOutputs(),
      outputSlots: env.getGeneratedOutputSlots(),
      claims: env.getClaims(),
      refs: env.getGeneratedRefs(),
      includeConstraints: env.getIncludeConstraints(),
      env,
    }));
  }
}

// -- Internal helpers -----------------------------------------------

function toErrorResult(e: unknown): ExecutionResult {
  if (e instanceof ContractRejection) {
    return { accepted: false, reason: e.message };
  }
  return { accepted: false, reason: `contract threw: ${e}` };
}
