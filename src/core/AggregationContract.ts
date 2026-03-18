// Protocol spec: docs/protocol/computation.md

import type { ContractFn } from './ContractEnv.ts';

/** Number of aggregation inputs required to trigger an aggregator. */
export const AGGREGATION_THRESHOLD = 4;

/**
 * Aggregation contract: requires exactly AGGREGATION_THRESHOLD inputs
 * (aggregation marker outputs from other blocks), then returns.
 *
 * When fewer than AGGREGATION_THRESHOLD inputs are available the contract
 * rejects, which cancels the draft.
 */
export const aggregationContract: ContractFn = (env) => {
  for (let i = 0; i < AGGREGATION_THRESHOLD; i++) {
    env.requireInput();
  }
};
