// Protocol spec: docs/protocol/execution-queue.md

import { ExecutionQueueConfig, ExecutionQueueModule } from './ExecutionQueueModule.ts';
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

/**
 * ExecutionQueueModule with node-local calibration factors exposed for
 * callers that derive budgets (e.g. `ContractVerificationService`).
 *
 * The protocol-specific `enqueueVerification` / `enqueueGeneration` helpers
 * that lived here have been removed -- callers now build their own
 * `Executable` objects and call the inherited generic `enqueue(task)`.
 * See docs/protocol/execution-queue.md.
 */
export class ExecutionQueueService extends ExecutionQueueModule {
  /** Economic-value -> wall-clock conversion. Public so budget-deriving services can read it. */
  readonly msPerCostUnit: number;
  /** Risk-transfer fee rate. Public so budget-deriving services can read it. */
  readonly feeRate: number;

  constructor(_ctx: ProtocolContext, config?: ExecutionQueueServiceConfig) {
    super(config);
    this.msPerCostUnit = config?.msPerCostUnit ?? SERVICE_DEFAULTS.msPerCostUnit;
    this.feeRate = config?.feeRate ?? SERVICE_DEFAULTS.feeRate;
  }
}
