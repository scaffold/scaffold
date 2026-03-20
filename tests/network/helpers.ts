/**
 * Shared helpers for network tests.
 * Re-exports common block construction utilities.
 */

import { Hash } from '../../src/util/Hash.ts';
import {
  AGGREGATION_CONTRACT,
  Block,
  BlockSource,
  createGenesisBlock,
  createSelfClaimedOutput,
  encodeAggregationData,
  RESULT_CONTRACT,
} from '../../src/core/Block.ts';
import { Output } from '../../src/core/BlockCreationModule.ts';
import { type ContractFn } from '../../src/core/ContractEnv.ts';

export const h = (name: string): Hash => Hash.digest(name);
export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export { AGGREGATION_CONTRACT, RESULT_CONTRACT };
export type { ContractFn };

export function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    detail: new Uint8Array([]),
  };
}

/** Create a leaf block with a random (but seeded) hash. */
export function makeLeafBlock(
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claims: number[] = [],
): Block {
  const hashParts: Uint8Array[] = [
    anchor.hash.toBytes(),
    new Uint8Array(new Float64Array([declaredWeight]).buffer),
    new Uint8Array(new Float64Array([Math.random()]).buffer),
  ];
  for (const out of outputs) {
    hashParts.push(out.verifier.contract.toBytes());
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
  }
  return {
    hash: Hash.digestParts(...hashParts),
    anchor: anchor.hash,
    aggregates: [],
    claims,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
}

/** Create a leaf block with a deterministic hash based on name. */
export function makeBlock(
  name: string,
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claims: number[] = [],
  refs: Hash[] = [],
): Block {
  return {
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: [],
    claims,
    outputs,
    declaredWeight,
    refs,
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
}

/** Standard genesis for multi-node tests. */
export function makeGenesis(outputCount = 4, valuePerOutput = 100): Block {
  const outputs = Array.from({ length: outputCount }, (_, i) =>
    makeOutput(valuePerOutput, `genesis-out-${i}`)
  );
  return createGenesisBlock(outputs);
}

/** Create an aggregation block that rolls up subtrees. */
export function makeAggregationBlock(
  name: string,
  anchor: Block,
  subtrees: Block[],
  opts: {
    anchorOutputCount: number;
    claimedIndices: number[];
    aggregateOutputCounts: number[];
    declaredWeight?: number;
  },
): Block {
  const { anchorOutputCount, claimedIndices, aggregateOutputCounts, declaredWeight = 1 } = opts;

  const subtreeWeights = subtrees.map((s) => s.declaredWeight);
  const totalSubtreeWeight = subtreeWeights.reduce((sum, w) => sum + w, 0);
  const totalSubtreeOutputs = aggregateOutputCounts.reduce((sum, c) => sum + c, 0);
  const newOutputCount = 1 + totalSubtreeOutputs; // 1 own output + subtree outputs

  const aggData = encodeAggregationData({
    claimMask: [...claimedIndices].sort((a, b) => a - b),
    newOutputCount,
    aggregateOutputCounts,
    chainWeights: [totalSubtreeWeight],
    aggregateWeights: subtreeWeights,
  });

  return {
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: subtrees.map((s) => s.hash),
    claims: [],
    outputs: [{
      verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
      value: 0,
      detail: aggData,
    }],
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
}

export { createSelfClaimedOutput };
