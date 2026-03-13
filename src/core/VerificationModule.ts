// Protocol spec: docs/protocol/computation.md (verification flow)

import { Hash } from '../util/Hash.ts';
import { ExecutionResult } from './ExecutionModule.ts';

// -- Provider -------------------------------------------------------

/** Provider interface for the verification module. */
export interface VerificationProvider {
  /** Select the highest-priority tree to verify next. */
  selectNextTree(): Hash | undefined;

  /** Verify a block and return the execution result. */
  verifyBlock(blockHash: Hash): ExecutionResult;

  /** Report a successful verification to the sampling module. */
  reportSuccess(treeHash: Hash): void;

  /** Report a failed verification to the sampling module. */
  reportFailure(treeHash: Hash): void;
}

/** Result of a verification attempt. */
export type VerificationResult =
  | { verified: true; treeHash: Hash }
  | { verified: false; treeHash: Hash; reason: string }
  | { verified: false; treeHash: undefined; reason: string };

/**
 * The verification module bridges sampling (what to verify) with
 * execution (how to verify). It selects trees based on sampling
 * priority, runs contract verification, and reports results back
 * to the sampling module.
 */
export class VerificationModule {
  private readonly _provider: VerificationProvider;

  constructor(provider: VerificationProvider) {
    this._provider = provider;
  }

  /**
   * Select the next tree to verify, run verification, and report the result.
   * Returns the verification result, or a "nothing to verify" result if no
   * trees are available.
   */
  verifyNext(): VerificationResult {
    const treeHash = this._provider.selectNextTree();
    if (!treeHash) {
      return { verified: false, treeHash: undefined, reason: 'no trees to verify' };
    }

    return this.verify(treeHash);
  }

  /** Verify a specific block and report the result to sampling. */
  verify(blockHash: Hash): VerificationResult {
    const execResult = this._provider.verifyBlock(blockHash);

    if (execResult.accepted) {
      this._provider.reportSuccess(blockHash);
      return { verified: true, treeHash: blockHash };
    }

    this._provider.reportFailure(blockHash);
    return { verified: false, treeHash: blockHash, reason: execResult.reason };
  }
}
