// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';
import { RESULT_CONTRACT } from './Block.ts';
import { ContractRejection } from './ContractEnv.ts';
import type { Contract } from './Contract.ts';
import { VerifyingEnv } from './VerifyingEnv.ts';

// -- Re-exports -------------------------------------------------------

export { ExecutionMode } from './ContractEnv.ts';
export type { Contract } from './Contract.ts';

// -- Types ----------------------------------------------------------

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

  /** Return the signer public key for a block, or undefined if unsigned. */
  getSigner(block: BlockType): Uint8Array | undefined;

  /** Return the block's timestamp (milliseconds since epoch). */
  getTimestamp(block: BlockType): number;
}

// -- ExecutionModule --------------------------------------------------

/**
 * The execution module runs contract verification on blocks.
 *
 * For each claimed output on a block, the module loads the output's contract
 * and runs it with a VerifyingEnv. All contracts must accept for the block
 * to be valid.
 *
 * Uses a contract registry (Hash -> Contract object) instead of raw WASM
 * instantiation. The interface mirrors WASM module exports -- real WASM
 * can be layered in later.
 */
export class ExecutionModule<BlockType> {
  private readonly _provider: ExecutionProvider<BlockType>;
  private readonly _contracts = new Map<HashPrimitive, Contract>();

  constructor(provider: ExecutionProvider<BlockType>) {
    this._provider = provider;
  }

  /** Register a contract for a contract hash. */
  registerContract(contractHash: Hash, contract: Contract): void {
    this._contracts.set(contractHash.toPrimitive(), contract);
  }

  /** Look up a registered contract by hash. */
  getContract(contractHash: Hash): Contract | undefined {
    return this._contracts.get(contractHash.toPrimitive());
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

      // Self-claimed outputs (RESULT_CONTRACT) are trivially valid:
      // the claiming block IS the producing block
      if (Hash.equals(claimedOutput.verifier.contract, RESULT_CONTRACT)) continue;

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
    if (Hash.equals(claimedOutput.verifier.contract, RESULT_CONTRACT)) {
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
    const contract = this._contracts.get(contractHash.toPrimitive());
    if (!contract) {
      return { accepted: false, reason: `contract not found: ${contractHash.toHex()}` };
    }

    const env = new VerifyingEnv({
      contractHash,
      params,
      block,
      outputs,
      claims,
      extendedOutputs: this._provider.getExtendedOutputs(block),
      refs: this._provider.getRefs(block),
      provider: this._provider,
      signer: this._provider.getSigner(block),
      timestamp: this._provider.getTimestamp(block),
    });

    try {
      contract.run(env);
    } catch (e) {
      if (e instanceof ContractRejection) {
        return { accepted: false, reason: e.message };
      }
      return { accepted: false, reason: `contract threw: ${e}` };
    }

    return { accepted: true };
  }
}
