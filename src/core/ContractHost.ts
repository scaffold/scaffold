// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { type MaybePromise, maybeThen } from '../util/MaybePromise.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import type { Contract } from '../contracts/Contract.ts';
import {
  ContractRejection,
  type GeneratingEnvProvider,
  type VerifyingEnvProvider,
} from './ContractEnv.ts';
import { VerifyingEnv } from './VerifyingEnv.ts';
import {
  GeneratingEnv,
  type OutputSlot,
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
  readonly claims: number[];
  readonly extendedOutputs: Output[];
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
  readonly resolvedClaims: { block: Hash; outputIndex: number; value: number }[];
  readonly refs: Hash[];
  readonly includeConstraints: Hash[];
  /** Exposed so callers can apply the default `collectInputs()` if the contract never called inputs-consuming methods. */
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
export class ContractHost<BlockType> {
  private readonly _contracts = new Map<HashPrimitive, Contract>();

  /** Register a contract implementation for a contract hash. */
  registerContract(contractHash: Hash, contract: Contract): void {
    this._contracts.set(contractHash.toPrimitive(), contract);
  }

  /** Look up a registered contract by hash. */
  getContract(contractHash: Hash): Contract | undefined {
    return this._contracts.get(contractHash.toPrimitive());
  }

  /**
   * Declared output namespaces for a registered contract. Returns `[]` if
   * the contract is unknown or declares nothing. See
   * docs/protocol/computation.md#output-namespaces.
   */
  getOutputNamespaces(contractHash: Hash): Hash[] {
    const contract = this._contracts.get(contractHash.toPrimitive());
    return contract?.outputNamespaces ?? [];
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
    const contract = this._contracts.get(input.verifier.contract.toPrimitive());
    if (!contract) {
      return { accepted: false, reason: `contract not found: ${input.verifier.contract.toHex()}` };
    }

    const env = new VerifyingEnv<BlockType>({
      contractHash: input.verifier.contract,
      params: input.verifier.params,
      block: input.block,
      outputs: input.outputs,
      claims: input.claims,
      extendedOutputs: input.extendedOutputs,
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
   * plus the env itself (so callers can invoke `env.collectInputs()` post-run
   * as a default when the contract never requested inputs).
   *
   * Throws ContractRejection / other errors up to the caller -- the caller
   * owns the draft lifecycle and decides what to do on rejection.
   */
  runGenerating(
    input: GeneratingRunInput<BlockType>,
  ): MaybePromise<GeneratingRunResult<BlockType>> {
    const contract = this._contracts.get(input.verifier.contract.toPrimitive());
    if (!contract) {
      throw new ContractRejection(`contract not found: ${input.verifier.contract.toHex()}`);
    }

    const env = new GeneratingEnv<BlockType>({
      contractHash: input.verifier.contract,
      params: input.verifier.params,
      provider: input.provider,
      waitForInput: input.waitForInput,
      waitForGetOutput: input.waitForGetOutput,
    });

    const result = contract.run(env);
    return maybeThen(result, () => ({
      outputs: env.getAllOutputs(),
      outputSlots: env.getGeneratedOutputSlots(),
      resolvedClaims: env.getResolvedClaims(),
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
