// Protocol spec: docs/protocol/aggregation.md

import type { ContractFn } from './ContractEnv.ts';
import {
  AGGREGATION_CONTRACT,
  decodeAggregationData,
  encodeAggregationData,
  type AggregationData,
} from './Block.ts';

/** Number of aggregation marker inputs required to produce an aggregation block. */
export const AGGREGATION_THRESHOLD = 4;

/**
 * Aggregation contract: consumes AGGREGATION_THRESHOLD marker outputs,
 * composes their subtree caches, and produces an aggregation data output.
 *
 * The contract accumulates per-aggregate output counts and weights.
 * The composed claimMask is computed at solidification time by the
 * OutputSpaceModule, which correctly handles arbitrary anchor depths.
 *
 * Each requireInput() call blocks if no marker is available, resuming
 * when the next marker becomes canonical.
 */
export const aggregationContract: ContractFn = async (env) => {
  const inputs = [];

  for (let i = 0; i < AGGREGATION_THRESHOLD; i++) {
    const input = await env.requireInput();
    inputs.push(input);
  }

  // Decode caches from consumed inputs.
  // Inputs with empty detail are leaves (implicit trivial cache).
  const caches: (AggregationData | null)[] = inputs.map((input) => {
    if (input.detail.length === 0) return null;
    return decodeAggregationData(input.detail);
  });

  // Compose: sum newOutputCounts, collect per-aggregate info.
  // claimMask is left empty -- computed at solidification by OutputSpaceModule.
  let composedNewOutputCount = 0;
  const aggregateOutputCounts: number[] = [];
  const aggregateWeights: number[] = [];
  const chainWeights: number[] = [];

  for (const cache of caches) {
    if (cache) {
      composedNewOutputCount += cache.newOutputCount;
      aggregateOutputCounts.push(cache.newOutputCount);
      aggregateWeights.push(
        cache.chainWeights.length > 0 ? cache.chainWeights[0] : 0,
      );

      for (let d = 0; d < cache.chainWeights.length; d++) {
        while (chainWeights.length <= d) chainWeights.push(0);
        chainWeights[d] += cache.chainWeights[d];
      }
    } else {
      // Leaf -- trivial cache
      aggregateOutputCounts.push(0);
      aggregateWeights.push(0);
    }
  }

  const composedData: AggregationData = {
    claimMask: [], // Computed at solidification time
    newOutputCount: composedNewOutputCount,
    aggregateOutputCounts,
    chainWeights,
    aggregateWeights,
  };

  env.requireOutput(
    { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
    0,
    encodeAggregationData(composedData),
  );
};
