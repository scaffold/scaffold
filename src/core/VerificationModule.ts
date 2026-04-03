// Protocol spec: docs/protocol/computation.md (verification flow)

import { Hash } from '../util/Hash.ts';
import { ExecutionResult } from './ExecutionModule.ts';
import { ProbeResult } from './ProbeModule.ts';

// -- Provider -------------------------------------------------------

/** Provider interface for the verification module. */
export interface VerificationProvider {
  /** Select the highest-priority tree to probe next. */
  selectNextTree(): Hash | undefined;

  /** Initiate a probe descent on a tree, returning the terminal block to verify. */
  initProbe(treeHash: Hash): ProbeResult;

  /** Verify a block by running its contracts. */
  verifyBlock(blockHash: Hash): ExecutionResult;

  /** Record verification result for a terminal block. */
  recordVerification(blockHash: Hash, success: boolean): void;
}

/** Result of a verification attempt. */
export type VerificationResult =
  | { verified: true; treeHash: Hash; terminalHash: Hash }
  | { verified: false; treeHash: Hash; reason: string }
  | { verified: false; treeHash: undefined; reason: string };

/**
 * The verification module bridges probing (what to verify) with
 * execution (how to verify). It selects trees based on probe priority,
 * descends to a terminal via probe, runs contract verification, and
 * reports results back to the probe module.
 */
export class VerificationModule {
  private readonly _provider: VerificationProvider;

  constructor(provider: VerificationProvider) {
    this._provider = provider;
  }

  /**
   * Select the next tree to verify, probe it, and verify the terminal.
   *
   * Flow:
   * 1. selectNextTree() picks the highest-priority tree
   * 2. initProbe() descends to a terminal block
   * 3. verifyBlock() runs the contract on the terminal
   * 4. recordVerification() reports the result to the probe module
   */
  verifyNext(): VerificationResult {
    const treeHash = this._provider.selectNextTree();
    if (!treeHash) {
      return { verified: false, treeHash: undefined, reason: 'no trees to verify' };
    }

    const probeResult = this._provider.initProbe(treeHash);
    if (!probeResult.terminal) {
      return { verified: false, treeHash, reason: probeResult.reason };
    }

    const terminalHash = probeResult.blockHash;
    const execResult = this._provider.verifyBlock(terminalHash);

    this._provider.recordVerification(terminalHash, execResult.accepted);

    if (execResult.accepted) {
      return { verified: true, treeHash, terminalHash };
    }

    return { verified: false, treeHash, reason: execResult.reason };
  }
}
