// Protocol spec: docs/protocol/aggregation.md

import type { Contract } from './Contract.ts';
import { AGGREGATION_CONTRACT, type Block } from '../core/Block.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import { Hash } from '../util/Hash.ts';

// -- AggregationData -----------------------------------------------

/**
 * Aggregation summary carried in an aggregation contract output's data field.
 * Contains the cached UTXO transformation state computed from subtrees.
 */
export interface AggregationData {
  /** Sorted anchor output indices claimed by the subtree. */
  claimMask: number[];
  /** Surviving new outputs added by this subtree (excludes anchor's surviving outputs). */
  newOutputCount: number;
  /** Per-subtree new output counts. */
  aggregateOutputCounts: number[];
  /** Weight vector from subtrees only (excludes own declaredWeight). */
  chainWeights: number[];
  /** Per-subtree declared weights. */
  aggregateWeights: number[];
}

/** Encode AggregationData to a Uint8Array for use in Output.data. */
export function encodeAggregationData(data: AggregationData): Uint8Array {
  const json = JSON.stringify({
    claimMask: data.claimMask,
    newOutputCount: data.newOutputCount,
    aggregateOutputCounts: data.aggregateOutputCounts,
    chainWeights: data.chainWeights,
    aggregateWeights: data.aggregateWeights,
  });
  return new TextEncoder().encode(json);
}

/** Decode AggregationData from an Output.data Uint8Array. */
export function decodeAggregationData(bytes: Uint8Array): AggregationData {
  const json = JSON.parse(new TextDecoder().decode(bytes));
  return {
    claimMask: json.claimMask as number[],
    newOutputCount: json.newOutputCount,
    aggregateOutputCounts: json.aggregateOutputCounts,
    chainWeights: json.chainWeights,
    aggregateWeights: json.aggregateWeights,
  };
}

/**
 * Find and decode the aggregation contract output from a block's outputs.
 * Returns null if the block has no aggregation contract output (leaf block).
 */
export function getAggregationData(block: Block): AggregationData | null {
  for (const output of block.outputs) {
    if (Hash.equals(output.verifier.contract, AGGREGATION_CONTRACT)) {
      if (output.data === undefined) continue; // data-less marker (if any)
      if (output.data.length === 0) continue; // empty-bytes marker (legacy)
      return decodeAggregationData(output.data);
    }
  }
  return null;
}

/**
 * Create an aggregation marker output. Every non-genesis block carries one
 * of these so that the aggregation contract can collect them.
 */
export function makeAggregationOutput(): Output {
  return {
    verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  };
}

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
 * Each claimNext() call blocks if no marker is available, resuming
 * when the next marker becomes canonical.
 */
export const aggregationContract: Contract = {
  // Getter (not field) to avoid a TDZ error: Block.ts has a circular import
  // of this module for `getAggregationData`, so at object-literal eval time
  // `AGGREGATION_CONTRACT` is not yet initialized. Lazy access defers the
  // read until `outputNamespaces` is actually consulted.
  get outputNamespaces() {
    return [AGGREGATION_CONTRACT];
  },

  async run(env) {
    const inputs = [];

    for (let i = 0; i < AGGREGATION_THRESHOLD; i++) {
      const input = await env.claimNext();
      inputs.push(input);
    }

    // Decode caches from consumed inputs.
    // Inputs with empty data are leaves (implicit trivial cache).
    const caches: (AggregationData | null)[] = inputs.map((input) => {
      if (input.data.length === 0) return null;
      return decodeAggregationData(input.data);
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

    env.emitOutput(
      { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
      0,
      encodeAggregationData(composedData),
    );
  },

  walkParams(params, host) {
    host.emitBytes('', params, {
      type: 'bytes',
      shortDescription: 'Aggregation params (empty)',
    });
  },

  walkData(data, host) {
    const aggData = decodeAggregationData(data);

    if (host.emitListStart('claimMask', aggData.claimMask.length)) {
      for (let i = 0; i < aggData.claimMask.length; i++) {
        host.emitNumber(String(i), aggData.claimMask[i], {
          type: 'i32',
          shortDescription: 'Claimed anchor output index',
        });
      }
      host.emitListEnd();
    }

    host.emitNumber('newOutputCount', aggData.newOutputCount, {
      type: 'i32',
      shortDescription: 'Surviving new outputs in subtree',
    });

    if (
      host.emitListStart(
        'aggregateOutputCounts',
        aggData.aggregateOutputCounts.length,
      )
    ) {
      for (let i = 0; i < aggData.aggregateOutputCounts.length; i++) {
        host.emitNumber(String(i), aggData.aggregateOutputCounts[i], {
          type: 'i32',
          shortDescription: 'Per-subtree new output count',
        });
      }
      host.emitListEnd();
    }

    if (host.emitListStart('chainWeights', aggData.chainWeights.length)) {
      for (let i = 0; i < aggData.chainWeights.length; i++) {
        host.emitNumber(String(i), aggData.chainWeights[i], {
          type: 'i32',
          shortDescription: 'Chain weight at depth',
        });
      }
      host.emitListEnd();
    }

    if (
      host.emitListStart('aggregateWeights', aggData.aggregateWeights.length)
    ) {
      for (let i = 0; i < aggData.aggregateWeights.length; i++) {
        host.emitNumber(String(i), aggData.aggregateWeights[i], {
          type: 'i32',
          shortDescription: 'Per-subtree declared weight',
        });
      }
      host.emitListEnd();
    }
  },
};
