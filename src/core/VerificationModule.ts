// Protocol spec: docs/protocol/computation.md (verification flow)

import { Hash } from '../util/Hash.ts';
import { ExecutionResult } from './ExecutionModule.ts';
import { SampleResult } from './SamplingModule.ts';

// -- Provider -------------------------------------------------------

/** Provider interface for the verification module. */
export interface VerificationProvider {
  /** Select the highest-priority tree to sample next. */
  selectNextTree(): Hash | undefined;

  /** Initiate a sample descent on a tree, returning the terminal block to verify. */
  initSample(treeHash: Hash): SampleResult;

  /** Verify a block by running its contracts. */
  verifyBlock(blockHash: Hash): Promise<ExecutionResult>;

  /** Record verification result for a terminal block. */
  recordVerification(blockHash: Hash, success: boolean): void;
}

/** Result of a verification attempt. */
export type VerificationResult =
  | { verified: true; treeHash: Hash; terminalHash: Hash }
  | { verified: false; treeHash: Hash; reason: string }
  | { verified: false; treeHash: undefined; reason: string };

/**
 * The verification module bridges sampling (what to verify) with
 * execution (how to verify). It selects trees based on sampling priority,
 * descends to a terminal via sampling, runs contract verification, and
 * reports results back to the sampling module.
 */
export class VerificationModule {
  private readonly _provider: VerificationProvider;

  constructor(provider: VerificationProvider) {
    this._provider = provider;
  }

  /**
   * Select the next tree to verify, sample it, and verify the terminal.
   *
   * Flow:
   * 1. selectNextTree() picks the highest-priority tree
   * 2. initSample() descends to a terminal block
   * 3. verifyBlock() runs the contract on the terminal
   * 4. recordVerification() reports the result to the sampling module
   */
  async verifyNext(): Promise<VerificationResult> {
    const treeHash = this._provider.selectNextTree();
    if (!treeHash) {
      return { verified: false, treeHash: undefined, reason: 'no trees to verify' };
    }

    const sampleResult = this._provider.initSample(treeHash);
    if (!sampleResult.terminal) {
      return { verified: false, treeHash, reason: sampleResult.reason };
    }

    const terminalHash = sampleResult.blockHash;
    const execResult = await this._provider.verifyBlock(terminalHash);

    this._provider.recordVerification(terminalHash, execResult.accepted);

    if (execResult.accepted) {
      return { verified: true, treeHash, terminalHash };
    }

    return { verified: false, treeHash, reason: execResult.reason };
  }
}
