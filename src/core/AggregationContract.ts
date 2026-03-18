// Protocol spec: docs/protocol/aggregation.md

import type { ContractFn } from './ContractEnv.ts';
import {
  AGGREGATION_CONTRACT,
  decodeAggregationData,
  encodeAggregationData,
  type AggregationData,
} from './Block.ts';
import { BitVector } from './BitVector.ts';

/** Number of aggregation marker inputs required to produce an aggregation block. */
export const AGGREGATION_THRESHOLD = 4;

/**
 * Aggregation contract: consumes AGGREGATION_THRESHOLD marker outputs,
 * composes their subtree caches, and produces an aggregation data output.
 *
 * Each requireInput() call blocks if no marker is available, resuming
 * when the next marker becomes canonical. This means the contract may
 * be suspended across multiple block arrivals.
 */
export const aggregationContract: ContractFn = async (env) => {
  const inputs = [];

  for (let i = 0; i < AGGREGATION_THRESHOLD; i++) {
    const input = await env.requireInput();
    inputs.push(input);
  }

  // Compose caches from consumed inputs.
  // Inputs with empty detail are leaves (implicit trivial cache).
  // Inputs with non-empty detail carry encoded AggregationData.
  const caches: (AggregationData | null)[] = inputs.map((input) => {
    if (input.detail.length === 0) return null; // leaf marker
    return decodeAggregationData(input.detail);
  });

  // Compose: union claim masks, sum newOutputCounts.
  // For leaves without a cache, we use trivial values.
  // Leaf newOutputCount is 0 here -- the real value will be computed
  // during solidification when the full block structure is known.
  let composedNewOutputCount = 0;
  const aggregateOutputCounts: number[] = [];
  const aggregateWeights: number[] = [];
  let composedClaimMask = BitVector.empty(0);
  const chainWeights: number[] = [];

  for (const cache of caches) {
    if (cache) {
      composedNewOutputCount += cache.newOutputCount;
      aggregateOutputCounts.push(cache.newOutputCount);
      aggregateWeights.push(
        cache.chainWeights.length > 0 ? cache.chainWeights[0] : 0,
      );

      // Union claim masks (resize if needed)
      if (cache.claimMask.length > composedClaimMask.length) {
        const resized = BitVector.empty(cache.claimMask.length);
        resized.or(composedClaimMask);
        composedClaimMask = resized;
      }
      composedClaimMask.or(cache.claimMask);

      // Accumulate chain weights
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
    claimMask: composedClaimMask,
    newOutputCount: composedNewOutputCount,
    aggregateOutputCounts,
    chainWeights,
    aggregateWeights,
  };

  // Produce the aggregation data output
  env.requireOutput(
    { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
    0,
    encodeAggregationData(composedData),
  );
};
