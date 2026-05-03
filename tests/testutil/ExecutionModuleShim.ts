// Test-only compat shim for the former `ExecutionModule.verifyBlock` loop.
//
// The production code no longer has a single "verify all claims on one block"
// primitive at the core layer -- that role split into `ContractHost`
// (run one verifier), `ContractVerificationModule` (dedupe cache), and
// `BlockVerificationModule` (per-block orchestration). Several contract
// correctness tests were written against the old surface; this shim lets
// them keep running without rewriting each test.
//
// Prefer the real services in new code. This is specifically for older
// contract tests.

import { Hash, HashPrimitive } from '../../src/util/Hash.ts';
import { Output, Verifier } from '../../src/core/BlockCreationModule.ts';
import type { Contract } from '../../src/contracts/Contract.ts';
import { ContractHost, type ExecutionResult } from '../../src/core/ContractHost.ts';
import type { VerifyingEnvProvider } from '../../src/core/ContractEnv.ts';

/** Provider interface matching the old `ExecutionModule.ExecutionProvider`. */
export interface ExecutionProvider<BlockType> {
  getBlock(hash: Hash): BlockType | undefined;
  getOutputs(block: BlockType): Output[];
  getRefs(block: BlockType): Hash[];
  getClaims(block: BlockType): number[];
  getAnchor(block: BlockType): Hash;
  /** Resolve a claim index in `block`'s extended vector to the underlying output. */
  resolveClaim(block: BlockType, claimIndex: number): Output | undefined;
  getSigner(block: BlockType): Uint8Array | undefined;
  getTimestamp(block: BlockType): number;
}

/**
 * Test shim: registry + per-block verify loop, identical in shape to the
 * old `ExecutionModule`. Internally delegates contract dispatch to
 * `ContractHost`. One contract run per claim (no grouping by contract,
 * which was a bug in the old module).
 */
export class ExecutionModuleShim<BlockType> {
  private readonly _provider: ExecutionProvider<BlockType>;
  private readonly _host = new ContractHost<BlockType>();
  private readonly _verifyProvider: VerifyingEnvProvider<BlockType>;

  constructor(provider: ExecutionProvider<BlockType>) {
    this._provider = provider;
    this._verifyProvider = {
      getBlock: (h) => provider.getBlock(h),
      getOutputs: (b) => provider.getOutputs(b),
      getClaims: (b) => provider.getClaims(b),
      resolveClaim: (b, i) => provider.resolveClaim(b, i),
      getRefs: (b) => provider.getRefs(b),
    };
  }

  registerContract(hash: Hash, contract: Contract): void {
    this._host.registerContract(hash, contract);
  }

  getContract(hash: Hash): Contract | undefined {
    return this._host.getContract(hash);
  }

  async verifyBlock(blockHash: Hash): Promise<ExecutionResult> {
    const block = this._provider.getBlock(blockHash);
    if (!block) return { accepted: false, reason: 'block not found' };

    const claims = this._provider.getClaims(block);

    // One run per claim -- per-verifier, not grouped by contract hash.
    const seen = new Set<string>();
    for (const claimIdx of claims) {
      const target = this._provider.resolveClaim(block, claimIdx);
      if (!target) {
        return { accepted: false, reason: `claim index ${claimIdx} out of bounds` };
      }
      const v = target.verifier;
      const key = `${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const result = await this._host.runVerifying({
        block,
        verifier: v,
        outputs: this._provider.getOutputs(block),
        claimIndices: claims,
        refs: this._provider.getRefs(block),
        signer: this._provider.getSigner(block),
        timestamp: this._provider.getTimestamp(block),
      }, this._verifyProvider);
      if (!result.accepted) return result;
    }

    return { accepted: true };
  }

  async verifyClaim(blockHash: Hash, claimIndex: number): Promise<ExecutionResult> {
    const block = this._provider.getBlock(blockHash);
    if (!block) return { accepted: false, reason: 'block not found' };
    const claims = this._provider.getClaims(block);
    if (claimIndex < 0 || claimIndex >= claims.length) {
      return { accepted: false, reason: 'claim index out of bounds' };
    }
    const target = this._provider.resolveClaim(block, claims[claimIndex]);
    if (!target) return { accepted: false, reason: 'claimed output not found' };

    return this._host.runVerifying({
      block,
      verifier: target.verifier,
      outputs: this._provider.getOutputs(block),
      claimIndices: claims,
      refs: this._provider.getRefs(block),
      signer: this._provider.getSigner(block),
      timestamp: this._provider.getTimestamp(block),
    }, this._verifyProvider);
  }
}

// Suppress unused-type warning for HashPrimitive which may be referenced
// via BlockType's own type arguments in callers.
export type { HashPrimitive, Verifier };
