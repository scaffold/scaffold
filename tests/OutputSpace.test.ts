import { assertEquals, assert } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import {
  type OutputSpaceBlock,
  type OutputSpaceLookup,
  type ResolvedOutput,
  mapSurvivingToOriginal,
  mapOriginalToSurviving,
  claimMasksOverlap,
  unionClaimMasks,
  subtreeFrom,
  totalOrdering,
  resolveClaimIndex,
  resolveOutputSpaceIndex,
  computeClaimIndex,
  computeOutputSpaceIndex,
  subtreeClaimMask,
  extendedVector,
  outputSpace,
} from '../src/core/OutputSpace.ts';

// -- Test helpers -------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

/** Count self-claims (claims with index < outputs.length). */
function selfClaimCount(block: { outputs: ReadonlyArray<unknown>; claims: readonly number[] }): number {
  return block.claims.filter((i) => i < block.outputs.length).length;
}

/** Create a genesis block. */
function makeGenesis(name: string, outputCount: number): OutputSpaceBlock {
  return {
    hash: h(name),
    anchor: ZERO_HASH,
    aggregates: [],
    outputs: Array.from({ length: outputCount }, (_, i) => ({ value: i + 1 })),
    claims: [],
    aggregateOutputCounts: [],
    newOutputCount: outputCount,
  };
}

/** Create a leaf block (no aggregates). */
function makeLeaf(opts: {
  name: string;
  anchor: string;
  outputCount: number;
  claims?: number[];
}): OutputSpaceBlock {
  const claims = opts.claims ?? [];
  const outputs = Array.from({ length: opts.outputCount }, (_, i) => ({ value: (i + 1) * 10 }));
  const sc = claims.filter((i) => i < outputs.length).length;
  return {
    hash: h(opts.name),
    anchor: h(opts.anchor),
    aggregates: [],
    outputs,
    claims: [...claims].sort((a, b) => a - b),
    aggregateOutputCounts: [],
    newOutputCount: outputs.length - sc,
  };
}

/** Create an aggregation block. */
function makeAggregator(opts: {
  name: string;
  anchor: string;
  outputCount: number;
  claims?: number[];
  aggregates: string[];
  aggregateOutputCounts: number[];
  newOutputCount: number;
}): OutputSpaceBlock {
  const claims = opts.claims ?? [];
  return {
    hash: h(opts.name),
    anchor: h(opts.anchor),
    aggregates: opts.aggregates.map(h),
    outputs: Array.from({ length: opts.outputCount }, (_, i) => ({ value: (i + 1) * 100 })),
    claims: [...claims].sort((a, b) => a - b),
    aggregateOutputCounts: opts.aggregateOutputCounts,
    newOutputCount: opts.newOutputCount,
  };
}

/** Build a lookup from a list of blocks. */
function buildLookup(blocks: OutputSpaceBlock[]): OutputSpaceLookup {
  const map = new Map<string, OutputSpaceBlock>();
  for (const b of blocks) {
    map.set(b.hash.toHex(), b);
  }
  return (hash: Hash) => map.get(hash.toHex());
}

/** Assert two ResolvedOutputs are equal. */
function assertResolved(
  actual: ResolvedOutput | undefined,
  expected: { name: string; outputIndex: number },
  msg?: string,
): void {
  assert(actual !== undefined, `Expected resolved output, got undefined. ${msg ?? ''}`);
  assertEquals(Hash.equals(actual.block, h(expected.name)), true,
    `Block mismatch: expected ${expected.name}. ${msg ?? ''}`);
  assertEquals(actual.outputIndex, expected.outputIndex,
    `Output index mismatch. ${msg ?? ''}`);
}

/**
 * Ground truth oracle: walk the total ordering, maintain a UTXO list.
 * Each block prepends its outputs, then resolves claims by identity
 * (using resolveClaimIndex to find the target output) and removes them.
 *
 * This validates that the ordering + claim resolution produce a consistent
 * UTXO evolution. The final state should match outputSpace().
 */
function naiveOutputSpace(
  tipHash: Hash,
  lookup: OutputSpaceLookup,
): Array<{ block: Hash; outputIndex: number }> {
  const order = totalOrdering(tipHash, lookup);
  let utxo: Array<{ block: Hash; outputIndex: number }> = [];

  for (const blockHash of order) {
    const block = lookup(blockHash)!;

    // Prepend own outputs
    const ownEntries = Array.from({ length: block.outputs.length }, (_, i) => ({
      block: blockHash,
      outputIndex: i,
    }));
    utxo = [...ownEntries, ...utxo];

    // Resolve each claim to its target output, then remove by identity
    for (const claimIdx of block.claims) {
      const resolved = resolveClaimIndex(blockHash, claimIdx, lookup);
      if (!resolved) continue;
      const pos = utxo.findIndex((e) =>
        Hash.equals(e.block, resolved.block) && e.outputIndex === resolved.outputIndex
      );
      if (pos >= 0) utxo.splice(pos, 1);
    }
  }

  return utxo;
}

// -- Sorted array helper tests ------------------------------------

Deno.test('mapSurvivingToOriginal: no claims', () => {
  assertEquals(mapSurvivingToOriginal(0, []), 0);
  assertEquals(mapSurvivingToOriginal(3, []), 3);
});

Deno.test('mapSurvivingToOriginal: with claims', () => {
  // Claims at [1, 3]: survivors are 0, 2, 4, 5, ...
  assertEquals(mapSurvivingToOriginal(0, [1, 3]), 0); // survivor 0 = original 0
  assertEquals(mapSurvivingToOriginal(1, [1, 3]), 2); // survivor 1 = original 2
  assertEquals(mapSurvivingToOriginal(2, [1, 3]), 4); // survivor 2 = original 4
});

Deno.test('mapOriginalToSurviving: no claims', () => {
  assertEquals(mapOriginalToSurviving(0, []), 0);
  assertEquals(mapOriginalToSurviving(5, []), 5);
});

Deno.test('mapOriginalToSurviving: with claims', () => {
  // Claims at [1, 3]
  assertEquals(mapOriginalToSurviving(0, [1, 3]), 0);
  assertEquals(mapOriginalToSurviving(1, [1, 3]), -1); // claimed
  assertEquals(mapOriginalToSurviving(2, [1, 3]), 1);
  assertEquals(mapOriginalToSurviving(3, [1, 3]), -1); // claimed
  assertEquals(mapOriginalToSurviving(4, [1, 3]), 2);
});

Deno.test('mapSurvivingToOriginal and mapOriginalToSurviving round-trip', () => {
  const claims = [1, 3, 5];
  for (let s = 0; s < 5; s++) {
    const original = mapSurvivingToOriginal(s, claims);
    assertEquals(mapOriginalToSurviving(original, claims), s,
      `Round-trip failed for surviving=${s}, original=${original}`);
  }
});

Deno.test('claimMasksOverlap: no overlap', () => {
  assertEquals(claimMasksOverlap([0, 2, 4], [1, 3, 5]), false);
});

Deno.test('claimMasksOverlap: overlap', () => {
  assertEquals(claimMasksOverlap([0, 2, 4], [2, 5]), true);
});

Deno.test('claimMasksOverlap: empty', () => {
  assertEquals(claimMasksOverlap([], [1, 2, 3]), false);
  assertEquals(claimMasksOverlap([], []), false);
});

Deno.test('unionClaimMasks: disjoint', () => {
  assertEquals(unionClaimMasks([0, 2], [1, 3]), [0, 1, 2, 3]);
});

Deno.test('unionClaimMasks: overlapping', () => {
  assertEquals(unionClaimMasks([0, 2, 4], [2, 3]), [0, 2, 3, 4]);
});

// -- S1: Single leaf block ----------------------------------------

Deno.test('S1: single leaf block - resolveClaimIndex', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [3] });
  const lookup = buildLookup([G, B]);

  // Self-reference
  assertResolved(resolveClaimIndex(h('B'), 0, lookup), { name: 'B', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('B'), 1, lookup), { name: 'B', outputIndex: 1 });

  // Claim index 3: inherited index 1 → G.outputs[1]
  assertResolved(resolveClaimIndex(h('B'), 3, lookup), { name: 'G', outputIndex: 1 });

  // Inherited index 0 → G.outputs[0]
  assertResolved(resolveClaimIndex(h('B'), 2, lookup), { name: 'G', outputIndex: 0 });
});

Deno.test('S1: single leaf block - computeClaimIndex round-trip', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [3] });
  const lookup = buildLookup([G, B]);

  // Round-trip for each claim
  const idx = computeClaimIndex(h('B'), { block: h('G'), outputIndex: 1 }, lookup);
  assertEquals(idx, 3);

  const idx2 = computeClaimIndex(h('B'), { block: h('B'), outputIndex: 0 }, lookup);
  assertEquals(idx2, 0);
});

Deno.test('S1: single leaf block - subtreeClaimMask', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [3] });
  const lookup = buildLookup([G, B]);

  // Claim 3 → inherited index 1 → anchor index 1
  assertEquals(subtreeClaimMask(h('B'), lookup), [1]);
});

Deno.test('S1: single leaf block - outputSpace', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [3] });
  const lookup = buildLookup([G, B]);

  const space = outputSpace(h('B'), lookup)!;
  assertEquals(space.length, 6); // 2 own + 5 anchor - 1 claim

  // B.0, B.1, G.0, G.2, G.3, G.4 (G.1 was claimed)
  assertResolved(space[0], { name: 'B', outputIndex: 0 });
  assertResolved(space[1], { name: 'B', outputIndex: 1 });
  assertResolved(space[2], { name: 'G', outputIndex: 0 });
  assertResolved(space[3], { name: 'G', outputIndex: 2 });
  assertResolved(space[4], { name: 'G', outputIndex: 3 });
  assertResolved(space[5], { name: 'G', outputIndex: 4 });
});

Deno.test('S1: single leaf block - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [3] });
  const lookup = buildLookup([G, B]);

  const space = outputSpace(h('B'), lookup)!;
  const naive = naiveOutputSpace(h('B'), lookup);

  assertEquals(space.length, naive.length);
  for (let i = 0; i < space.length; i++) {
    assertEquals(Hash.equals(space[i].block, naive[i].block), true,
      `Mismatch at index ${i}: block`);
    assertEquals(space[i].outputIndex, naive[i].outputIndex,
      `Mismatch at index ${i}: outputIndex`);
  }
});

// -- S2: Linear chain G→A→B→C ------------------------------------

Deno.test('S2: linear chain - resolveClaimIndex at each level', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [4] }); // G.2
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [3] }); // A's space[2] = A.1
  // A's output space: [A.0, A.1, G.0, G.1, G.3, G.4] (G.2 claimed)
  // B's extended: [B.0, A.0, A.1, G.0, G.1, G.3, G.4]
  // B claims [3] → G.0... wait.
  // B's extended vector index 3 → inherited index 2 → A's output space[2] = G.0
  // Hmm let me recalculate.
  // A's output space: A claims [4] from extended [A.0, A.1, G.0, G.1, G.2, G.3, G.4]
  //   claim 4 removes G.2. Surviving: [A.0, A.1, G.0, G.1, G.3, G.4]
  // B's extended: [B.0, A.0, A.1, G.0, G.1, G.3, G.4]
  //   B claims [3] → removes G.0
  const lookup = buildLookup([G, A, B]);

  // B claim 3 → inherited 2 → A's output space[2] → A's extended[2] (no claims < 2 in A.claims=[4])
  // A's extended[2] = G.0
  assertResolved(resolveClaimIndex(h('B'), 3, lookup), { name: 'G', outputIndex: 0 });

  // A claim 4 → inherited 2 → G's output space[2] = G.2
  assertResolved(resolveClaimIndex(h('A'), 4, lookup), { name: 'G', outputIndex: 2 });
});

Deno.test('S2: linear chain - subtreeClaimMask at each level', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [4] });
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [3] });
  const lookup = buildLookup([G, A, B]);

  assertEquals(subtreeClaimMask(h('A'), lookup), [2]); // A claims G.2
  assertEquals(subtreeClaimMask(h('B'), lookup), [2]); // B claims A's space[2] → A.ext[2] → A's output space entry for G.0... wait

  // B's claim mask is against A's output space. B claims inherited index 2.
  // That's index 2 in A's output space = G.0. In A's output space indices,
  // that's position 2. So B's subtreeClaimMask against A = [2].
  assertEquals(subtreeClaimMask(h('B'), lookup), [2]);
});

Deno.test('S2: linear chain - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [4] });
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [3] });
  const lookup = buildLookup([G, A, B]);

  for (const blockName of ['A', 'B']) {
    const space = outputSpace(h(blockName), lookup)!;
    const naive = naiveOutputSpace(h(blockName), lookup);
    assertEquals(space.length, naive.length, `${blockName}: length mismatch`);
    for (let i = 0; i < space.length; i++) {
      assertEquals(Hash.equals(space[i].block, naive[i].block), true,
        `${blockName}[${i}]: block mismatch`);
      assertEquals(space[i].outputIndex, naive[i].outputIndex,
        `${blockName}[${i}]: outputIndex mismatch`);
    }
  }
});

Deno.test('S2: linear chain - computeClaimIndex round-trip', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [4] });
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [3] });
  const lookup = buildLookup([G, A, B]);

  // For B: claim 3 resolves to G.0
  const resolved = resolveClaimIndex(h('B'), 3, lookup)!;
  const roundTrip = computeClaimIndex(h('B'), resolved, lookup);
  assertEquals(roundTrip, 3);

  // For A: claim 4 resolves to G.2
  const resolvedA = resolveClaimIndex(h('A'), 4, lookup)!;
  const roundTripA = computeClaimIndex(h('A'), resolvedA, lookup);
  assertEquals(roundTripA, 4);
});

// -- S3: Sibling aggregation G→{B,C}→D ---------------------------

Deno.test('S3: sibling aggregation - subtreeFrom', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [5] }); // G.2
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] }); // G.1
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B', 'C'],
    aggregateOutputCounts: [3, 2],
    newOutputCount: 6, // 1 own + 3 from B + 2 from C
  });
  const lookup = buildLookup([G, B, C, D]);

  const order = totalOrdering(h('D'), lookup);
  // ordering(D) = [...ordering(G), subtreeFrom(B, G), subtreeFrom(C, G), D]
  // = [G, B, C, D]
  assertEquals(order.length, 4);
  assertEquals(Hash.equals(order[0], h('G')), true);
  assertEquals(Hash.equals(order[1], h('B')), true);
  assertEquals(Hash.equals(order[2], h('C')), true);
  assertEquals(Hash.equals(order[3], h('D')), true);
});

Deno.test('S3: sibling aggregation - resolveClaimIndex', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [5] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] });
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B', 'C'],
    aggregateOutputCounts: [3, 2],
    newOutputCount: 6,
  });
  const lookup = buildLookup([G, B, C, D]);

  // D's extended vector: [D.0, C.0, C.1, B.0, B.1, B.2, G.surviving...]
  // G has 10 outputs. B claims G.2, C claims G.1.
  // G surviving (after B+C): [G.0, G.3, G.4, G.5, G.6, G.7, G.8, G.9]

  // Index 0: D's own output
  assertResolved(resolveClaimIndex(h('D'), 0, lookup), { name: 'D', outputIndex: 0 });

  // Index 1: C's output space[0] = C.0
  assertResolved(resolveClaimIndex(h('D'), 1, lookup), { name: 'C', outputIndex: 0 });

  // Index 2: C's output space[1] = C.1
  assertResolved(resolveClaimIndex(h('D'), 2, lookup), { name: 'C', outputIndex: 1 });

  // Index 3: B's output space[0] = B.0
  assertResolved(resolveClaimIndex(h('D'), 3, lookup), { name: 'B', outputIndex: 0 });

  // Index 5: B's output space[2] = B.2
  assertResolved(resolveClaimIndex(h('D'), 5, lookup), { name: 'B', outputIndex: 2 });

  // Index 6: anchor surviving[0] = G.0
  assertResolved(resolveClaimIndex(h('D'), 6, lookup), { name: 'G', outputIndex: 0 });

  // Index 7: anchor surviving[1] = G.3
  assertResolved(resolveClaimIndex(h('D'), 7, lookup), { name: 'G', outputIndex: 3 });
});

Deno.test('S3: sibling aggregation - subtreeClaimMask', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [5] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] });
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B', 'C'],
    aggregateOutputCounts: [3, 2],
    newOutputCount: 6,
  });
  const lookup = buildLookup([G, B, C, D]);

  // B claims G.2, C claims G.1
  assertEquals(subtreeClaimMask(h('D'), lookup), [1, 2]);
});

Deno.test('S3: sibling aggregation - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [5] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] });
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B', 'C'],
    aggregateOutputCounts: [3, 2],
    newOutputCount: 6,
  });
  const lookup = buildLookup([G, B, C, D]);

  const space = outputSpace(h('D'), lookup)!;
  const naive = naiveOutputSpace(h('D'), lookup);

  assertEquals(space.length, naive.length, `Length mismatch: ${space.length} vs ${naive.length}`);
  for (let i = 0; i < space.length; i++) {
    assertEquals(Hash.equals(space[i].block, naive[i].block), true,
      `D space[${i}]: block mismatch`);
    assertEquals(space[i].outputIndex, naive[i].outputIndex,
      `D space[${i}]: outputIndex mismatch`);
  }
});

Deno.test('S3: sibling aggregation - computeClaimIndex round-trip', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [5] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] });
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B', 'C'],
    aggregateOutputCounts: [3, 2],
    newOutputCount: 6,
  });
  const lookup = buildLookup([G, B, C, D]);

  // Round-trip every position in D's extended vector
  const ext = extendedVector(h('D'), lookup)!;
  for (let i = 0; i < ext.length; i++) {
    const resolved = resolveClaimIndex(h('D'), i, lookup)!;
    const roundTrip = computeClaimIndex(h('D'), resolved, lookup);
    assertEquals(roundTrip, i, `Round-trip failed for index ${i}`);
  }
});

// -- S4: Linear aggregation G→A→B→C, D aggregates C with anchor A

Deno.test('S4: linear aggregation - subtreeFrom', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [3] }); // G.1
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [2] }); // A's space[1] = A.1
  // A's output space: [A.0, A.1, G.0, G.2, G.3, G.4] (A claims G.1)
  // B claims index 2 → A's output space[1] = A.1
  // Wait: B's ext = [B.0, A.0, A.1, G.0, G.2, G.3, G.4], claim [2] removes A.1
  const C = makeLeaf({ name: 'C', anchor: 'B', outputCount: 1, claims: [] });
  const lookup = buildLookup([G, A, B, C]);

  const sub = subtreeFrom(h('C'), h('A'), lookup);
  // Should follow: C.anchor=B, B.anchor=A (stop). So [B, C].
  assertEquals(sub.length, 2);
  assertEquals(Hash.equals(sub[0], h('B')), true);
  assertEquals(Hash.equals(sub[1], h('C')), true);
});

Deno.test('S4: linear aggregation - D aggregates C with anchor A', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [3] }); // G.1
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [2] }); // A.1
  const C = makeLeaf({ name: 'C', anchor: 'B', outputCount: 1, claims: [] });

  // C's subtree from A = [B, C].
  // B: 1 output, 0 self-claims → newOutputCount = 1
  // C: 1 output, 0 self-claims → newOutputCount = 1
  // Total subtree newOutputCount for C's subtree = 2

  // B claims A.1 (anchor claim against A). subtreeClaimMask for C's subtree against A = [1]
  // Actually, B's anchor is A, and B claims index 2 from ext [B.0, A.0, A.1, G.0, G.2, G.3, G.4]
  // Index 2 = A.1. In A's output space, A.1 is at index 1. So B's subtreeClaimMask against A = [1].
  // C has no claims, so C's subtreeClaimMask against B = [].

  // For D aggregating C with anchor A:
  // The aggregateOutputCounts for [C] = the subtree's newOutputCount (B.new + C.new = 2)
  // But wait, C is an aggregation block from D's perspective? No, C is a leaf. But C's subtree
  // includes B (via anchor chain). So C needs to have cache data for its subtree from A.
  //
  // For a block C that is being aggregated into D with anchor A, the relevant newOutputCount
  // is the total new outputs of the subtree from A: B's new (1) + C's new (1) = 2.
  // And the claimMask against A = [1] (B claims A.1).

  const D = makeAggregator({
    name: 'D', anchor: 'A', outputCount: 1, claims: [],
    aggregates: ['C'],
    aggregateOutputCounts: [2], // B's new + C's new
    newOutputCount: 3, // D's 1 own + 2 from subtree
  });
  const lookup = buildLookup([G, A, B, C, D]);

  // D's total ordering: [...ordering(A), subtreeFrom(C, A), D]
  //   = [...ordering(A), B, C, D]
  //   = [G, A, B, C, D]
  const order = totalOrdering(h('D'), lookup);
  assertEquals(order.length, 5);

  // D's extended vector: [D.0, C.subtree's new outputs, A's surviving]
  // C's subtree from A = [B, C]. Processing:
  //   After A: [A.0, A.1, G.0, G.2, G.3, G.4]
  //   Process B: prepend B.0 → [B.0, A.0, A.1, G.0, G.2, G.3, G.4], claim [2] removes A.1
  //     → [B.0, A.0, G.0, G.2, G.3, G.4]
  //   Process C: prepend C.0 → [C.0, B.0, A.0, G.0, G.2, G.3, G.4], no claims
  // C's output space = [C.0, B.0, A.0, G.0, G.2, G.3, G.4]
  // C's new outputs (first 2 entries, since C.subtree.newOutputCount = 2): [C.0, B.0]
  //
  // Wait -- which entries are "new"? The first newOutputCount entries of C's output space.
  // C.newOutputCount would be 1 (leaf, no self-claims). But from D's perspective,
  // D.aggregateOutputCounts[0] = 2 (the subtree's total new outputs).
  // So D takes the first 2 entries of C's output space as the aggregate's new outputs: [C.0, B.0]
  //
  // A's surviving after subtree claims: subtreeClaimMask = [1], so A's output space
  //   [A.0, A.1, G.0, G.2, G.3, G.4] minus index 1 (A.1) = [A.0, G.0, G.2, G.3, G.4]
  //
  // D's extended vector: [D.0, C.0, B.0, A.0, G.0, G.2, G.3, G.4]

  assertResolved(resolveClaimIndex(h('D'), 0, lookup), { name: 'D', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('D'), 1, lookup), { name: 'C', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('D'), 2, lookup), { name: 'B', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('D'), 3, lookup), { name: 'A', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('D'), 4, lookup), { name: 'G', outputIndex: 0 });
});

Deno.test('S4: linear aggregation - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 5);
  const A = makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claims: [3] });
  const B = makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claims: [2] });
  const C = makeLeaf({ name: 'C', anchor: 'B', outputCount: 1, claims: [] });
  const D = makeAggregator({
    name: 'D', anchor: 'A', outputCount: 1, claims: [],
    aggregates: ['C'],
    aggregateOutputCounts: [2],
    newOutputCount: 3,
  });
  const lookup = buildLookup([G, A, B, C, D]);

  const space = outputSpace(h('D'), lookup)!;
  const naive = naiveOutputSpace(h('D'), lookup);

  assertEquals(space.length, naive.length, `Length mismatch: ${space.length} vs ${naive.length}`);
  for (let i = 0; i < space.length; i++) {
    assertEquals(Hash.equals(space[i].block, naive[i].block), true,
      `D space[${i}]: block mismatch, got ${space[i].block.toHex().slice(0, 8)} ` +
      `expected ${naive[i].block.toHex().slice(0, 8)}`);
    assertEquals(space[i].outputIndex, naive[i].outputIndex,
      `D space[${i}]: outputIndex mismatch`);
  }
});

// -- S5: Multi-level G→{B→E, C→F}→AGG ----------------------------

Deno.test('S5: multi-level aggregation - resolveClaimIndex', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [4] }); // G.2
  const E = makeLeaf({ name: 'E', anchor: 'B', outputCount: 1, claims: [] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] }); // G.1
  const F = makeLeaf({ name: 'F', anchor: 'C', outputCount: 1, claims: [] });

  // E's subtree from G = [B, E]. newOutputCount = B.new(2) + E.new(1) = 3
  // E's subtreeClaimMask against G = B's mask = [2]
  // F's subtree from G = [C, F]. newOutputCount = C.new(2) + F.new(1) = 3
  // F's subtreeClaimMask against G = C's mask = [1]

  const AGG = makeAggregator({
    name: 'AGG', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['E', 'F'],
    aggregateOutputCounts: [3, 3],
    newOutputCount: 7, // 1 own + 3 from E + 3 from F
  });
  const lookup = buildLookup([G, B, E, C, F, AGG]);

  // AGG's extended vector: [AGG.0, F.subtree.new, E.subtree.new, G.surviving]
  // F.subtree.new (first 3 of F's output space): F's output space = [F.0, C.0, C.1, G.surviving after C's claims]
  //   C claims G.1, so G.surviving from C = [G.0, G.2, G.3, ...G.9]
  //   F output space: [F.0, C.0, C.1, G.0, G.2, G.3, ..., G.9]
  //   First 3: [F.0, C.0, C.1]
  // E.subtree.new (first 3 of E's output space): E's output space = [E.0, B.0, B.1, G.surviving after B's claims]
  //   B claims G.2, so G.surviving from B = [G.0, G.1, G.3, ..., G.9]
  //   E output space: [E.0, B.0, B.1, G.0, G.1, G.3, ..., G.9]
  //   First 3: [E.0, B.0, B.1]
  // G.surviving after E+F claims: claimMask = union([2], [1]) = [1, 2]
  //   G surviving = [G.0, G.3, G.4, G.5, G.6, G.7, G.8, G.9]
  //
  // AGG extended: [AGG.0, F.0, C.0, C.1, E.0, B.0, B.1, G.0, G.3, G.4, ...]

  assertResolved(resolveClaimIndex(h('AGG'), 0, lookup), { name: 'AGG', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('AGG'), 1, lookup), { name: 'F', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('AGG'), 2, lookup), { name: 'C', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('AGG'), 3, lookup), { name: 'C', outputIndex: 1 });
  assertResolved(resolveClaimIndex(h('AGG'), 4, lookup), { name: 'E', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('AGG'), 5, lookup), { name: 'B', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('AGG'), 6, lookup), { name: 'B', outputIndex: 1 });
  assertResolved(resolveClaimIndex(h('AGG'), 7, lookup), { name: 'G', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('AGG'), 8, lookup), { name: 'G', outputIndex: 3 });
});

Deno.test('S5: multi-level aggregation - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [4] });
  const E = makeLeaf({ name: 'E', anchor: 'B', outputCount: 1, claims: [] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] });
  const F = makeLeaf({ name: 'F', anchor: 'C', outputCount: 1, claims: [] });
  const AGG = makeAggregator({
    name: 'AGG', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['E', 'F'],
    aggregateOutputCounts: [3, 3],
    newOutputCount: 7,
  });
  const lookup = buildLookup([G, B, E, C, F, AGG]);

  const space = outputSpace(h('AGG'), lookup)!;
  const naive = naiveOutputSpace(h('AGG'), lookup);

  assertEquals(space.length, naive.length, `Length: ${space.length} vs ${naive.length}`);
  for (let i = 0; i < space.length; i++) {
    assertEquals(Hash.equals(space[i].block, naive[i].block), true,
      `AGG space[${i}]: block mismatch`);
    assertEquals(space[i].outputIndex, naive[i].outputIndex,
      `AGG space[${i}]: outputIndex mismatch`);
  }
});

Deno.test('S5: multi-level aggregation - computeClaimIndex round-trip', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claims: [4] });
  const E = makeLeaf({ name: 'E', anchor: 'B', outputCount: 1, claims: [] });
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] });
  const F = makeLeaf({ name: 'F', anchor: 'C', outputCount: 1, claims: [] });
  const AGG = makeAggregator({
    name: 'AGG', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['E', 'F'],
    aggregateOutputCounts: [3, 3],
    newOutputCount: 7,
  });
  const lookup = buildLookup([G, B, E, C, F, AGG]);

  const ext = extendedVector(h('AGG'), lookup)!;
  for (let i = 0; i < ext.length; i++) {
    const resolved = resolveClaimIndex(h('AGG'), i, lookup)!;
    const roundTrip = computeClaimIndex(h('AGG'), resolved, lookup);
    assertEquals(roundTrip, i, `Round-trip failed for index ${i}`);
  }
});

// -- S6: Self-claiming --------------------------------------------

Deno.test('S6: self-claiming - resolveClaimIndex', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0, 1, 4] });
  // Self-claims: 0 and 1. Anchor claim: 4 → inherited index 1 → G.1
  const lookup = buildLookup([G, B]);

  assertResolved(resolveClaimIndex(h('B'), 0, lookup), { name: 'B', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('B'), 1, lookup), { name: 'B', outputIndex: 1 });
  assertResolved(resolveClaimIndex(h('B'), 4, lookup), { name: 'G', outputIndex: 1 });
});

Deno.test('S6: self-claiming - subtreeClaimMask excludes self-claims', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0, 1, 4] });
  const lookup = buildLookup([G, B]);

  // Only non-self claim: 4 → inherited 1 → anchor index 1
  assertEquals(subtreeClaimMask(h('B'), lookup), [1]);
});

Deno.test('S6: self-claiming - outputSpace', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0, 1, 4] });
  const lookup = buildLookup([G, B]);

  const space = outputSpace(h('B'), lookup)!;
  // 3 outputs - 2 self-claims = 1 surviving own + 5 anchor - 1 claim = 5 total
  assertEquals(space.length, 5);
  assertResolved(space[0], { name: 'B', outputIndex: 2 }); // only surviving own output
  assertResolved(space[1], { name: 'G', outputIndex: 0 });
  assertResolved(space[2], { name: 'G', outputIndex: 2 });
  assertResolved(space[3], { name: 'G', outputIndex: 3 });
  assertResolved(space[4], { name: 'G', outputIndex: 4 });
});

Deno.test('S6: self-claiming - newOutputCount', () => {
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0, 1, 4] });
  assertEquals(B.newOutputCount, 1); // 3 - 2 self-claims
});

Deno.test('S6: self-claiming - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0, 1, 4] });
  const lookup = buildLookup([G, B]);

  const space = outputSpace(h('B'), lookup)!;
  const naive = naiveOutputSpace(h('B'), lookup);

  assertEquals(space.length, naive.length);
  for (let i = 0; i < space.length; i++) {
    assertEquals(Hash.equals(space[i].block, naive[i].block), true,
      `S6[${i}]: block mismatch`);
    assertEquals(space[i].outputIndex, naive[i].outputIndex,
      `S6[${i}]: outputIndex mismatch`);
  }
});

// -- S7: Self-claiming aggregate (parent navigates through) -------

Deno.test('S7: self-claiming aggregate - resolveClaimIndex navigates past self-claims', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0] });
  // B self-claims index 0. newOutputCount = 2.
  // B's output space: [B.1, B.2, G.0, G.1, G.2, G.3, G.4]

  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B'],
    aggregateOutputCounts: [2], // B's newOutputCount
    newOutputCount: 3, // 1 own + 2 from B
  });
  const lookup = buildLookup([G, B, D]);

  // D's extended vector: [D.0, B's surviving new (B.1, B.2), G.surviving]
  // Since B has no anchor claims, G.surviving = G's full output space.
  assertResolved(resolveClaimIndex(h('D'), 0, lookup), { name: 'D', outputIndex: 0 });
  assertResolved(resolveClaimIndex(h('D'), 1, lookup), { name: 'B', outputIndex: 1 });
  assertResolved(resolveClaimIndex(h('D'), 2, lookup), { name: 'B', outputIndex: 2 });
  assertResolved(resolveClaimIndex(h('D'), 3, lookup), { name: 'G', outputIndex: 0 });
});

Deno.test('S7: self-claiming aggregate - outputSpace matches ground truth', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0] });
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B'],
    aggregateOutputCounts: [2],
    newOutputCount: 3,
  });
  const lookup = buildLookup([G, B, D]);

  const space = outputSpace(h('D'), lookup)!;
  const naive = naiveOutputSpace(h('D'), lookup);

  assertEquals(space.length, naive.length, `Length: ${space.length} vs ${naive.length}`);
  for (let i = 0; i < space.length; i++) {
    assertEquals(Hash.equals(space[i].block, naive[i].block), true,
      `S7 D[${i}]: block mismatch`);
    assertEquals(space[i].outputIndex, naive[i].outputIndex,
      `S7 D[${i}]: outputIndex mismatch`);
  }
});

Deno.test('S7: self-claiming aggregate - computeClaimIndex round-trip', () => {
  const G = makeGenesis('G', 5);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [0] });
  const D = makeAggregator({
    name: 'D', anchor: 'G', outputCount: 1, claims: [],
    aggregates: ['B'],
    aggregateOutputCounts: [2],
    newOutputCount: 3,
  });
  const lookup = buildLookup([G, B, D]);

  const ext = extendedVector(h('D'), lookup)!;
  for (let i = 0; i < ext.length; i++) {
    const resolved = resolveClaimIndex(h('D'), i, lookup)!;
    const roundTrip = computeClaimIndex(h('D'), resolved, lookup);
    assertEquals(roundTrip, i, `Round-trip failed for index ${i}`);
  }
});

// -- S8: Overlapping claims (conflict detection) ------------------

Deno.test('S8: overlapping claims detected', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [3] }); // G.0
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [2] }); // G.0
  const lookup = buildLookup([G, B, C]);

  const maskB = subtreeClaimMask(h('B'), lookup)!;
  const maskC = subtreeClaimMask(h('C'), lookup)!;

  assertEquals(maskB, [0]);
  assertEquals(maskC, [0]);
  assertEquals(claimMasksOverlap(maskB, maskC), true);
});

Deno.test('S8: non-overlapping claims', () => {
  const G = makeGenesis('G', 10);
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claims: [3] }); // G.0
  const C = makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claims: [3] }); // G.1
  const lookup = buildLookup([G, B, C]);

  const maskB = subtreeClaimMask(h('B'), lookup)!;
  const maskC = subtreeClaimMask(h('C'), lookup)!;

  assertEquals(maskB, [0]);
  assertEquals(maskC, [1]);
  assertEquals(claimMasksOverlap(maskB, maskC), false);
});

// -- Genesis edge case --------------------------------------------

Deno.test('genesis block has trivial output space', () => {
  const G = makeGenesis('G', 5);
  const lookup = buildLookup([G]);

  const space = outputSpace(h('G'), lookup)!;
  assertEquals(space.length, 5);
  for (let i = 0; i < 5; i++) {
    assertResolved(space[i], { name: 'G', outputIndex: i });
  }
});

Deno.test('totalOrdering for genesis is just [genesis]', () => {
  const G = makeGenesis('G', 5);
  const lookup = buildLookup([G]);

  const order = totalOrdering(h('G'), lookup);
  assertEquals(order.length, 1);
  assertEquals(Hash.equals(order[0], h('G')), true);
});
