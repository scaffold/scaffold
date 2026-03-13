// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';
import { SELF_CONTRACT } from './Block.ts';

// -- Types ----------------------------------------------------------

/** Execution mode: generation (building a block) or verification (checking one). */
export enum ExecutionMode {
  Generation = 0,
  Verification = 1,
}

/** Result of executing a contract for a single claimed output. */
export type ExecutionResult =
  | { accepted: true }
  | { accepted: false; reason: string };

// -- Provider -------------------------------------------------------

/** Provider interface for the execution module to access block data. */
export interface ExecutionProvider<BlockType> {
  /** Return the block for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the outputs for a block. */
  getOutputs(block: BlockType): Output[];

  /** Return the refs for a block. */
  getRefs(block: BlockType): Hash[];

  /** Return the claim indices for a block. */
  getClaims(block: BlockType): number[];

  /** Return the anchor hash for a block. */
  getAnchor(block: BlockType): Hash;

  /** Return the extended output vector for a block (own outputs + surviving anchor outputs). */
  getExtendedOutputs(block: BlockType): Output[];
}

// -- Contract function type -----------------------------------------

/**
 * A contract function receives a HostContext and performs verification.
 * It should call ctx.accept() or ctx.reject() to indicate the result.
 * For the mock implementation, contracts are TypeScript functions.
 */
export type ContractFn = (ctx: HostContext) => void;

// -- HostContext -----------------------------------------------------

/**
 * The host environment for a single contract invocation.
 * Provides host functions as specified in the computation protocol.
 */
export class HostContext {
  readonly mode: ExecutionMode;
  readonly currentContract: Hash;
  readonly currentParams: Uint8Array;

  private _result: ExecutionResult | null = null;
  private readonly _block: unknown;
  private readonly _outputs: Output[];
  private readonly _claims: number[];
  private readonly _refs: Hash[];
  private readonly _provider: ExecutionProvider<unknown>;
  private readonly _extendedOutputs: Output[];

  // Generation mode state
  private readonly _generatedSelfClaims: Output[] = [];
  private readonly _generatedOutputs: Output[] = [];

  constructor(opts: {
    mode: ExecutionMode;
    contract: Hash;
    params: Uint8Array;
    block: unknown;
    outputs: Output[];
    claims: number[];
    refs: Hash[];
    provider: ExecutionProvider<unknown>;
    extendedOutputs: Output[];
  }) {
    this.mode = opts.mode;
    this.currentContract = opts.contract;
    this.currentParams = opts.params;
    this._block = opts.block;
    this._outputs = opts.outputs;
    this._claims = opts.claims;
    this._refs = opts.refs;
    this._provider = opts.provider;
    this._extendedOutputs = opts.extendedOutputs;
  }

  /** Get the execution result, or null if not yet terminated. */
  get result(): ExecutionResult | null {
    return this._result;
  }

  // -- Self-claimed output data (set_data) ----------------------------

  /**
   * In generation mode: creates a self-claimed output.
   * In verification mode: checks a matching self-claimed output exists.
   */
  setData(key: string | Uint8Array, value: Uint8Array): void {
    const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;

    if (this.mode === ExecutionMode.Generation) {
      this._generatedSelfClaims.push({
        verifier: { contract: SELF_CONTRACT, params: keyBytes },
        value: 0,
        detail: value,
      });
      return;
    }

    // Verification: find a matching self-claimed output on the block
    for (const output of this._outputs) {
      if (!Hash.equals(output.verifier.contract, SELF_CONTRACT)) continue;
      if (!bytesEqual(output.verifier.params, keyBytes)) continue;
      if (!bytesEqual(output.detail, value)) {
        this.reject(`self-claimed output key="${typeof key === 'string' ? key : '<bytes>'}" has wrong value`);
        return;
      }
      return; // match found
    }
    this.reject(`self-claimed output key="${typeof key === 'string' ? key : '<bytes>'}" not found`);
  }

  // -- Claimed outputs ------------------------------------------------

  /** Number of outputs being claimed by this block. */
  claimedOutputCount(): number {
    return this._claims.length;
  }

  /** Get the detail of a claimed output by index into the claims array. */
  claimedOutputDetail(index: number): Uint8Array {
    const output = this._getClaimedOutput(index);
    return output ? output.detail : new Uint8Array(0);
  }

  /** Get the verifier of a claimed output by index into the claims array. */
  claimedOutputVerifier(index: number): { contract: Hash; params: Uint8Array } | undefined {
    const output = this._getClaimedOutput(index);
    return output ? output.verifier : undefined;
  }

  private _getClaimedOutput(index: number): Output | undefined {
    if (index < 0 || index >= this._claims.length) return undefined;
    const claimIdx = this._claims[index];
    return this._extendedOutputs[claimIdx];
  }

  // -- Output requirements (add_output) -------------------------------

  /**
   * In generation mode: creates an output on the block.
   * In verification mode: checks a matching output exists.
   */
  addOutput(contract: Hash, params: Uint8Array, value: number, detail: Uint8Array): void {
    if (this.mode === ExecutionMode.Generation) {
      this._generatedOutputs.push({
        verifier: { contract, params },
        value,
        detail,
      });
      return;
    }

    // Verification: check that a matching output exists on the block
    for (const output of this._outputs) {
      if (
        Hash.equals(output.verifier.contract, contract) &&
        bytesEqual(output.verifier.params, params) &&
        output.value === value &&
        bytesEqual(output.detail, detail)
      ) {
        return; // match found
      }
    }
    this.reject('required output not found on block');
  }

  // -- Constraints ----------------------------------------------------

  /** Assert the block's signature matches the given public key. */
  requireSignature(pubkey: Uint8Array): void {
    // For the mock implementation, check params contains the expected pubkey
    if (!bytesEqual(this.currentParams, pubkey)) {
      this.reject('signature requirement not met');
    }
  }

  // -- Cross-block references -----------------------------------------

  /** Number of referenced blocks. */
  refCount(): number {
    return this._refs.length;
  }

  /** Number of outputs on a referenced block. */
  refOutputCount(refIndex: number): number {
    const outputs = this._getRefOutputs(refIndex);
    return outputs ? outputs.length : 0;
  }

  /** Get the detail of an output on a referenced block. */
  refOutputDetail(refIndex: number, outputIndex: number): Uint8Array {
    const outputs = this._getRefOutputs(refIndex);
    if (!outputs || outputIndex < 0 || outputIndex >= outputs.length) {
      return new Uint8Array(0);
    }
    return outputs[outputIndex].detail;
  }

  /** Get the verifier of an output on a referenced block. */
  refOutputVerifier(refIndex: number, outputIndex: number): { contract: Hash; params: Uint8Array } | undefined {
    const outputs = this._getRefOutputs(refIndex);
    if (!outputs || outputIndex < 0 || outputIndex >= outputs.length) {
      return undefined;
    }
    return outputs[outputIndex].verifier;
  }

  private _getRefOutputs(refIndex: number): Output[] | undefined {
    if (refIndex < 0 || refIndex >= this._refs.length) return undefined;
    const refHash = this._refs[refIndex];
    const refBlock = this._provider.getBlock(refHash);
    if (!refBlock) return undefined;
    return this._provider.getOutputs(refBlock);
  }

  // -- Terminal -------------------------------------------------------

  /** Accept: the spending condition is satisfied. */
  accept(): void {
    if (this._result) return; // already terminated
    this._result = { accepted: true };
  }

  /** Reject: the spending condition is not satisfied. */
  reject(reason?: string): void {
    if (this._result) return; // already terminated
    this._result = { accepted: false, reason: reason ?? 'rejected' };
  }

  // -- Generation mode accessors --------------------------------------

  /** Get the self-claimed outputs generated during execution (generation mode only). */
  getGeneratedSelfClaims(): Output[] {
    return this._generatedSelfClaims;
  }

  /** Get the outputs generated during execution (generation mode only). */
  getGeneratedOutputs(): Output[] {
    return this._generatedOutputs;
  }
}

// -- ExecutionModule --------------------------------------------------

/**
 * The execution module runs contract verification on blocks.
 *
 * For each claimed output on a block, the module loads the output's contract
 * and runs it with a HostContext. All contracts must accept for the block
 * to be valid.
 *
 * Uses a mock contract registry (Hash → TypeScript function) instead of
 * real WASM instantiation. The interface is the same — real WASM can be
 * layered in later.
 */
export class ExecutionModule<BlockType> {
  private readonly _provider: ExecutionProvider<BlockType>;
  private readonly _contracts = new Map<HashPrimitive, ContractFn>();

  constructor(provider: ExecutionProvider<BlockType>) {
    this._provider = provider;
  }

  /** Register a TypeScript mock contract function for a contract hash. */
  registerContract(contractHash: Hash, fn: ContractFn): void {
    this._contracts.set(contractHash.toPrimitive(), fn);
  }

  /**
   * Verify an entire block: run all claimed output contracts.
   * Returns accepted if all contracts accept (or there are no non-self claims).
   */
  verifyBlock(blockHash: Hash): ExecutionResult {
    const block = this._provider.getBlock(blockHash);
    if (!block) return { accepted: false, reason: 'block not found' };

    const claims = this._provider.getClaims(block);
    const outputs = this._provider.getOutputs(block);
    const extendedOutputs = this._provider.getExtendedOutputs(block);

    // Group claims by the claimed output's contract
    // Each unique contract needs to run once
    const contractClaims = new Map<HashPrimitive, number[]>();
    for (let i = 0; i < claims.length; i++) {
      const claimIdx = claims[i];
      const claimedOutput = extendedOutputs[claimIdx];
      if (!claimedOutput) {
        return { accepted: false, reason: `claim index ${claimIdx} out of bounds` };
      }

      // Self-claimed outputs (SELF_CONTRACT) are trivially valid:
      // the claiming block IS the producing block
      if (Hash.equals(claimedOutput.verifier.contract, SELF_CONTRACT)) continue;

      const key = claimedOutput.verifier.contract.toPrimitive();
      let group = contractClaims.get(key);
      if (!group) {
        group = [];
        contractClaims.set(key, group);
      }
      group.push(i);
    }

    // Run each contract
    for (const [contractKey, _claimIndices] of contractClaims) {
      const contractHash = Hash.fromPrimitive(contractKey);
      const claimedOutput = extendedOutputs[claims[_claimIndices[0]]];
      const result = this._runContract(
        contractHash,
        claimedOutput.verifier.params,
        block,
        outputs,
        claims,
      );
      if (!result.accepted) return result;
    }

    return { accepted: true };
  }

  /**
   * Verify a single claimed output by its index in the claims array.
   */
  verifyClaim(blockHash: Hash, claimIndex: number): ExecutionResult {
    const block = this._provider.getBlock(blockHash);
    if (!block) return { accepted: false, reason: 'block not found' };

    const claims = this._provider.getClaims(block);
    if (claimIndex < 0 || claimIndex >= claims.length) {
      return { accepted: false, reason: 'claim index out of bounds' };
    }

    const extendedOutputs = this._provider.getExtendedOutputs(block);
    const claimedOutput = extendedOutputs[claims[claimIndex]];
    if (!claimedOutput) {
      return { accepted: false, reason: 'claimed output not found' };
    }

    // Self-claimed outputs are trivially valid
    if (Hash.equals(claimedOutput.verifier.contract, SELF_CONTRACT)) {
      return { accepted: true };
    }

    return this._runContract(
      claimedOutput.verifier.contract,
      claimedOutput.verifier.params,
      block,
      this._provider.getOutputs(block),
      claims,
    );
  }

  private _runContract(
    contractHash: Hash,
    params: Uint8Array,
    block: BlockType,
    outputs: Output[],
    claims: number[],
  ): ExecutionResult {
    const contractFn = this._contracts.get(contractHash.toPrimitive());
    if (!contractFn) {
      return { accepted: false, reason: `contract not found: ${contractHash.toHex()}` };
    }

    const ctx = new HostContext({
      mode: ExecutionMode.Verification,
      contract: contractHash,
      params,
      block,
      outputs,
      claims,
      refs: this._provider.getRefs(block),
      provider: this._provider as ExecutionProvider<unknown>,
      extendedOutputs: this._provider.getExtendedOutputs(block),
    });

    try {
      contractFn(ctx);
    } catch (e) {
      return { accepted: false, reason: `contract threw: ${e}` };
    }

    if (!ctx.result) {
      return { accepted: false, reason: 'contract did not call accept() or reject()' };
    }

    return ctx.result;
  }
}

// -- Utilities -------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
