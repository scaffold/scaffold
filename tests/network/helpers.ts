/**
 * Shared helpers for network tests.
 * Re-exports common block construction utilities.
 */

import { Hash } from '../../src/util/Hash.ts';
import { withNodeFields } from '../testutil/blockNodeFields.ts';

import {
  AGGREGATION_CONTRACT,
  AtomSource,
  AtomType,
  Block,
  createGenesisBlock,
  RECORD_CONTRACT,
} from '../../src/core/Block.ts';
import { PacketType } from '../../src/core/Packet.ts';
import { makeRecordOutput } from '../../src/contracts/RecordContract.ts';
import { encodeAggregationData } from '../../src/contracts/AggregationContract.ts';
import { Output } from '../../src/core/BlockCreationModule.ts';
import type { Contract } from '../../src/contracts/Contract.ts';

export const h = (name: string): Hash => Hash.digest(name);
export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export { AGGREGATION_CONTRACT, AtomType, RECORD_CONTRACT };
export { PacketType };
export type { Contract };

/**
 * Default Atom-base fields for test Block fixtures that don't go
 * through `composeUnsignedBlockPacket`. The `raw` is a stub (empty
 * bytes) -- such fixtures are not safe to round-trip over the wire,
 * but they're sufficient for in-memory module-level tests.
 */
export const TEST_ATOM_BASE = {
  type: AtomType.Block as const,
  packetType: PacketType.JsonUnsignedBlock as const,
  raw: new Uint8Array(0),
  // Transit fields are mutable; each call site needs its own freshly-
  // allocated array/set, so make this a getter-style spread per-fixture.
};

/** Spread alongside TEST_ATOM_BASE for each fresh test atom fixture. */
export function freshTransit(): { fromConnections: string[]; toConnections: Set<string> } {
  return { fromConnections: [], toConnections: new Set() };
}

export function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    body: new Uint8Array([]),
  };
}

/** Create a leaf block with a random (but seeded) hash. */
export function makeLeafBlock(
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claimIndices: number[] = [],
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
  return withNodeFields({
    ...TEST_ATOM_BASE,
    ...freshTransit(),
    hash: Hash.digestParts(...hashParts),
    anchor: anchor.hash,
    aggregates: [],
    claimIndices,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: AtomSource.Local,
  });
}

/** Create a leaf block with a deterministic hash based on name. */
export function makeBlock(
  name: string,
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claimIndices: number[] = [],
  refs: Hash[] = [],
): Block {
  return withNodeFields({
    ...TEST_ATOM_BASE,
    ...freshTransit(),
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: [],
    claimIndices,
    outputs,
    declaredWeight,
    refs,
    timestamp: 0,
    receivedAt: 0,
    source: AtomSource.Local,
  });
}

/** Standard genesis for multi-node tests. */
export function makeGenesis(outputCount = 4, valuePerOutput = 100): Block {
  const outputs = Array.from(
    { length: outputCount },
    (_, i) => makeOutput(valuePerOutput, `genesis-out-${i}`),
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

  return withNodeFields({
    ...TEST_ATOM_BASE,
    ...freshTransit(),
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: subtrees.map((s) => s.hash),
    claimIndices: [],
    outputs: [{
      verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
      value: 0,
      body: aggData,
    }],
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: AtomSource.Local,
  });
}

export { makeRecordOutput };
