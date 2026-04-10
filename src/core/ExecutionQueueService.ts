// Protocol spec: docs/protocol/execution-queue.md

import { Hash } from '../util/Hash.ts';
import { ExecutionService } from './ExecutionService.ts';
import { SamplingService } from './SamplingService.ts';
import { Executable, ExecutionQueueConfig, ExecutionQueueModule } from './ExecutionQueueModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

/**
 * Configuration for the execution queue service, extending the module config
 * with node-local calibration factors.
 */
export interface ExecutionQueueServiceConfig extends ExecutionQueueConfig {
  /**
   * Conversion factor: economic value -> wall-clock ms.
   * A powerful node sets a low value (can do more per ms).
   * Default: 1.0 (1 unit of value = 1ms of wall-clock time).
   */
  msPerCostUnit?: number;

  /**
   * Risk transfer fee rate: fraction of insurance deposit paid to aggregator.
   * Default: 0.05 (5%).
   */
  feeRate?: number;
}

const SERVICE_DEFAULTS = {
  msPerCostUnit: 1.0,
  feeRate: 0.05,
};

/** ExecutionQueueModule with protocol-specific enqueue methods. */
export class ExecutionQueueService extends ExecutionQueueModule {
  private readonly sampling: SamplingService;
  private readonly execution: ExecutionService;
  private readonly msPerCostUnit: number;
  private readonly feeRate: number;

  constructor(ctx: ProtocolContext, config?: ExecutionQueueServiceConfig) {
    super(config);
    this.sampling = ctx.get(SamplingService);
    this.execution = ctx.get(ExecutionService);
    this.msPerCostUnit = config?.msPerCostUnit ?? SERVICE_DEFAULTS.msPerCostUnit;
    this.feeRate = config?.feeRate ?? SERVICE_DEFAULTS.feeRate;
  }

  /**
   * Enqueue a verification task.
   * Returns the task ID, or undefined if rejected (cost too large).
   */
  enqueueVerification(treeHash: Hash, terminalHash: Hash): string | undefined {
    // TODO(@joel): derive budget from insurance deposit via TrustModule once available.
    // For now, derive from the tree's total weight.
    const totalWeight = this.sampling.getTotalWeight(treeHash);
    if (totalWeight <= 0) return undefined;
    const budget = totalWeight * this.feeRate * this.msPerCostUnit;

    const sampling = this.sampling;
    const execution = this.execution;

    const executable: Executable = {
      priority: () => sampling.getPriority(treeHash),
      maxCostMs: budget,
      run: async () => {
        const result = await execution.verifyBlock(terminalHash);
        sampling.recordVerification(terminalHash, result.accepted);
      },
      onTimeout: () => {
        sampling.recordVerification(terminalHash, false);
      },
    };

    return this.enqueue(executable);
  }

  /**
   * Enqueue a generation task.
   * Returns the task ID, or undefined if rejected.
   */
  enqueueGeneration(_draftId: string, expectedProfit: number, run: () => Promise<void>): string
    | undefined {
    const budget = expectedProfit * this.msPerCostUnit;
    if (budget <= 0) return undefined;

    const executable: Executable = {
      priority: () => expectedProfit,
      maxCostMs: budget,
      run,
    };

    return this.enqueue(executable);
  }
}
