import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import {
  claimMasksOverlap,
  filterAboveAndShift,
  mapOriginalToSurviving,
  mapSurvivingToOriginal,
  mapSurvivingToOriginalBatch,
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
  type ResolvedOutput,
  unionClaimMasks,
} from '../src/core/OutputSpace.ts';

// -- Test helpers -------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

/** Create a genesis block. */
function makeGenesis(name: string, outputCount: number): OutputSpaceBlock {
  return {
    hash: h(name),
    anchor: ZERO_HASH,
    aggregates: [],
    outputs: Array.from({ length: outputCount }, (_, i) => ({ value: i + 1 })),
    claimIndices: [],
    aggregateOutputCounts: [],
    newOutputCount: outputCount,
  };
}

/** Create a leaf block (no aggregates). */
function makeLeaf(opts: {
  name: string;
  anchor: string;
  outputCount: number;
  claimIndices?: number[];
}): OutputSpaceBlock {
  const claims = opts.claimIndices ?? [];
  const outputs = Array.from({ length: opts.outputCount }, (_, i) => ({ value: (i + 1) * 10 }));
  const sc = claims.filter((i) => i < outputs.length).length;
  return {
    hash: h(opts.name),
    anchor: h(opts.anchor),
    aggregates: [],
    outputs,
    claimIndices: [...claims].sort((a, b) => a - b),
    aggregateOutputCounts: [],
    newOutputCount: outputs.length - sc,
  };
}

/** Create an aggregation block. */
function makeAggregator(opts: {
  name: string;
  anchor: string;
  outputCount: number;
  claimIndices?: number[];
  aggregates: string[];
  aggregateOutputCounts: number[];
  newOutputCount: number;
}): OutputSpaceBlock {
  const claims = opts.claimIndices ?? [];
  return {
    hash: h(opts.name),
    anchor: h(opts.anchor),
    aggregates: opts.aggregates.map(h),
    outputs: Array.from({ length: opts.outputCount }, (_, i) => ({ value: (i + 1) * 100 })),
    claimIndices: [...claims].sort((a, b) => a - b),
    aggregateOutputCounts: opts.aggregateOutputCounts,
    newOutputCount: opts.newOutputCount,
  };
}

/** Build a provider from a list of blocks. */
function buildProvider(blocks: OutputSpaceBlock[]): OutputSpaceProvider {
  const map = new Map<string, OutputSpaceBlock>();
  for (const b of blocks) {
    map.set(b.hash.toHex(), b);
  }
  return { getBlock: (hash: Hash) => map.get(hash.toHex()) };
}

/** Build an OutputSpaceModule from a list of blocks. */
function buildModule(blocks: OutputSpaceBlock[]): OutputSpaceModule {
  return new OutputSpaceModule(buildProvider(blocks));
}

/** Assert two ResolvedOutputs are equal. */
function assertResolved(
  actual: ResolvedOutput | undefined,
  expected: { name: string; outputIndex: number },
  msg?: string,
): void {
  assert(actual !== undefined, `Expected resolved output, got undefined. ${msg ?? ''}`);
  assertEquals(
    Hash.equals(actual.block, h(expected.name)),
    true,
    `Block mismatch: expected ${expected.name}. ${msg ?? ''}`,
  );
  assertEquals(actual.outputIndex, expected.outputIndex, `Output index mismatch. ${msg ?? ''}`);
}

/**
 * Ground truth oracle: walk the total ordering, maintain a UTXO list.
 * Each block prepends its outputs, then resolves claims by identity
 * (using resolveClaimIndex to find the target output) and removes them.
 */
function naiveOutputSpace(
  mod: OutputSpaceModule,
  tipHash: Hash,
  provider: OutputSpaceProvider,
): Array<{ block: Hash; outputIndex: number }> {
  const order = mod.totalOrdering(tipHash);
  let utxo: Array<{ block: Hash; outputIndex: number }> = [];

  for (const blockHash of order) {
    const block = provider.getBlock(blockHash)!;

    const ownEntries = Array.from({ length: block.outputs.length }, (_, i) => ({
      block: blockHash,
      outputIndex: i,
    }));
    utxo = [...ownEntries, ...utxo];

    for (const claimIdx of block.claimIndices) {
      const resolved = mod.resolveClaimIndex(blockHash, claimIdx);
      if (!resolved) continue;
      const pos = utxo.findIndex((e) =>
        Hash.equals(e.block, resolved.block) && e.outputIndex === resolved.outputIndex
      );
      if (pos >= 0) utxo.splice(pos, 1);
    }
  }

  return utxo;
}

/** Helper to run ground truth comparison against outputSpace(). */
function assertMatchesGroundTruth(
  blocks: OutputSpaceBlock[],
  tipName: string,
  label?: string,
): void {
  const provider = buildProvider(blocks);
  const mod = new OutputSpaceModule(provider);
  const space = mod.outputSpace(h(tipName))!;
  const naive = naiveOutputSpace(mod, h(tipName), provider);
  const prefix = label ?? tipName;

  assertEquals(
    space.length,
    naive.length,
    `${prefix}: length mismatch: ${space.length} vs ${naive.length}`,
  );
  for (let i = 0; i < space.length; i++) {
    assertEquals(
      Hash.equals(space[i].block, naive[i].block),
      true,
      `${prefix}[${i}]: block mismatch`,
    );
    assertEquals(
      space[i].outputIndex,
      naive[i].outputIndex,
      `${prefix}[${i}]: outputIndex mismatch`,
    );
  }
}

// -- Sorted array helper tests ------------------------------------

Deno.test('mapSurvivingToOriginal: no claims', () => {
  assertEquals(mapSurvivingToOriginal(0, []), 0);
  assertEquals(mapSurvivingToOriginal(3, []), 3);
});

Deno.test('mapSurvivingToOriginal: with claims', () => {
  assertEquals(mapSurvivingToOriginal(0, [1, 3]), 0);
  assertEquals(mapSurvivingToOriginal(1, [1, 3]), 2);
  assertEquals(mapSurvivingToOriginal(2, [1, 3]), 4);
});

Deno.test('mapSurvivingToOriginalBatch: empty inputs', () => {
  assertEquals(mapSurvivingToOriginalBatch([], [1, 3]), []);
  assertEquals(mapSurvivingToOriginalBatch([0, 1, 2], []), [0, 1, 2]);
});

Deno.test('mapSurvivingToOriginalBatch: matches single-index version', () => {
  const claims = [1, 3, 5];
  const survivors = [0, 1, 2, 3, 4];
  const batch = mapSurvivingToOriginalBatch(survivors, claims);
  const single = survivors.map((s) => mapSurvivingToOriginal(s, claims));
  assertEquals(batch, single);
});

Deno.test('filterAboveAndShift: basic', () => {
  assertEquals(filterAboveAndShift([1, 3, 5, 7], 3), [0, 2, 4]);
  assertEquals(filterAboveAndShift([0, 1, 2], 2), [0]);
  assertEquals(filterAboveAndShift([0, 1, 2], 5), []);
  assertEquals(filterAboveAndShift([], 3), []);
});

Deno.test('filterAboveAndShift: threshold 0 shifts everything', () => {
  assertEquals(filterAboveAndShift([3, 5, 7], 0), [3, 5, 7]);
});

Deno.test('mapOriginalToSurviving: no claims', () => {
  assertEquals(mapOriginalToSurviving(0, []), 0);
  assertEquals(mapOriginalToSurviving(5, []), 5);
});

Deno.test('mapOriginalToSurviving: with claims', () => {
  assertEquals(mapOriginalToSurviving(0, [1, 3]), 0);
  assertEquals(mapOriginalToSurviving(1, [1, 3]), -1);
  assertEquals(mapOriginalToSurviving(2, [1, 3]), 1);
  assertEquals(mapOriginalToSurviving(3, [1, 3]), -1);
  assertEquals(mapOriginalToSurviving(4, [1, 3]), 2);
});

Deno.test('mapSurvivingToOriginal and mapOriginalToSurviving round-trip', () => {
  const claims = [1, 3, 5];
  for (let s = 0; s < 5; s++) {
    const original = mapSurvivingToOriginal(s, claims);
    assertEquals(
      mapOriginalToSurviving(original, claims),
      s,
      `Round-trip failed for surviving=${s}, original=${original}`,
    );
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
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [3] }),
  ]);

  assertResolved(mod.resolveClaimIndex(h('B'), 0), { name: 'B', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('B'), 1), { name: 'B', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('B'), 3), { name: 'G', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('B'), 2), { name: 'G', outputIndex: 0 });
});

Deno.test('S1: single leaf block - computeClaimIndex round-trip', () => {
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [3] }),
  ]);

  assertEquals(mod.computeClaimIndex(h('B'), { block: h('G'), outputIndex: 1 }), 3);
  assertEquals(mod.computeClaimIndex(h('B'), { block: h('B'), outputIndex: 0 }), 0);
});

Deno.test('S1: single leaf block - subtreeClaimMask', () => {
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [3] }),
  ]);
  assertEquals(mod.subtreeClaimMask(h('B')), [1]);
});

Deno.test('S1: single leaf block - outputSpace', () => {
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [3] }),
  ]);
  const space = mod.outputSpace(h('B'))!;
  assertEquals(space.length, 6);
  assertResolved(space[0], { name: 'B', outputIndex: 0 });
  assertResolved(space[1], { name: 'B', outputIndex: 1 });
  assertResolved(space[2], { name: 'G', outputIndex: 0 });
  assertResolved(space[3], { name: 'G', outputIndex: 2 });
  assertResolved(space[4], { name: 'G', outputIndex: 3 });
  assertResolved(space[5], { name: 'G', outputIndex: 4 });
});

Deno.test('S1: single leaf block - outputSpace matches ground truth', () => {
  assertMatchesGroundTruth(
    [makeGenesis('G', 5), makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [3] })],
    'B',
  );
});

// -- S2: Linear chain G→A→B→C ------------------------------------

Deno.test('S2: linear chain - resolveClaimIndex at each level', () => {
  const blocks = [
    makeGenesis('G', 5),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [4] }),
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claimIndices: [3] }),
  ];
  const mod = buildModule(blocks);

  assertResolved(mod.resolveClaimIndex(h('B'), 3), { name: 'G', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('A'), 4), { name: 'G', outputIndex: 2 });
});

Deno.test('S2: linear chain - subtreeClaimMask at each level', () => {
  const blocks = [
    makeGenesis('G', 5),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [4] }),
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claimIndices: [3] }),
  ];
  const mod = buildModule(blocks);

  assertEquals(mod.subtreeClaimMask(h('A')), [2]);
  assertEquals(mod.subtreeClaimMask(h('B')), [2]);
});

Deno.test('S2: linear chain - outputSpace matches ground truth', () => {
  const blocks = [
    makeGenesis('G', 5),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [4] }),
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claimIndices: [3] }),
  ];
  assertMatchesGroundTruth(blocks, 'A');
  assertMatchesGroundTruth(blocks, 'B');
});

Deno.test('S2: linear chain - computeClaimIndex round-trip', () => {
  const blocks = [
    makeGenesis('G', 5),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [4] }),
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claimIndices: [3] }),
  ];
  const mod = buildModule(blocks);

  const resolved = mod.resolveClaimIndex(h('B'), 3)!;
  assertEquals(mod.computeClaimIndex(h('B'), resolved), 3);

  const resolvedA = mod.resolveClaimIndex(h('A'), 4)!;
  assertEquals(mod.computeClaimIndex(h('A'), resolvedA), 4);
});

// -- S3: Sibling aggregation G→{B,C}→D ---------------------------

function s3Blocks() {
  return [
    makeGenesis('G', 10),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [5] }),
    makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claimIndices: [3] }),
    makeAggregator({
      name: 'D',
      anchor: 'G',
      outputCount: 1,
      claimIndices: [],
      aggregates: ['B', 'C'],
      aggregateOutputCounts: [3, 2],
      newOutputCount: 6,
    }),
  ];
}

Deno.test('S3: sibling aggregation - subtreeFrom', () => {
  const mod = buildModule(s3Blocks());
  const order = mod.totalOrdering(h('D'));
  assertEquals(order.length, 4);
  assertEquals(Hash.equals(order[0], h('G')), true);
  assertEquals(Hash.equals(order[1], h('B')), true);
  assertEquals(Hash.equals(order[2], h('C')), true);
  assertEquals(Hash.equals(order[3], h('D')), true);
});

Deno.test('S3: sibling aggregation - resolveClaimIndex', () => {
  const mod = buildModule(s3Blocks());

  assertResolved(mod.resolveClaimIndex(h('D'), 0), { name: 'D', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 1), { name: 'C', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 2), { name: 'C', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('D'), 3), { name: 'B', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 5), { name: 'B', outputIndex: 2 });
  assertResolved(mod.resolveClaimIndex(h('D'), 6), { name: 'G', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 7), { name: 'G', outputIndex: 3 });
});

Deno.test('S3: sibling aggregation - subtreeClaimMask', () => {
  const mod = buildModule(s3Blocks());
  assertEquals(mod.subtreeClaimMask(h('D')), [1, 2]);
});

Deno.test('S3: sibling aggregation - outputSpace matches ground truth', () => {
  assertMatchesGroundTruth(s3Blocks(), 'D');
});

Deno.test('S3: sibling aggregation - computeClaimIndex round-trip', () => {
  const mod = buildModule(s3Blocks());
  const ext = mod.extendedVector(h('D'))!;
  for (let i = 0; i < ext.length; i++) {
    const resolved = mod.resolveClaimIndex(h('D'), i)!;
    assertEquals(mod.computeClaimIndex(h('D'), resolved), i, `Round-trip failed for index ${i}`);
  }
});

// -- S4: Linear aggregation G→A→B→C, D aggregates C with anchor A

function s4Blocks() {
  return [
    makeGenesis('G', 5),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [3] }),
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claimIndices: [2] }),
    makeLeaf({ name: 'C', anchor: 'B', outputCount: 1, claimIndices: [] }),
    makeAggregator({
      name: 'D',
      anchor: 'A',
      outputCount: 1,
      claimIndices: [],
      aggregates: ['C'],
      aggregateOutputCounts: [2],
      newOutputCount: 3,
    }),
  ];
}

Deno.test('S4: linear aggregation - subtreeFrom', () => {
  const mod = buildModule(s4Blocks());
  const sub = mod.subtreeFrom(h('C'), h('A'));
  assertEquals(sub.length, 2);
  assertEquals(Hash.equals(sub[0], h('B')), true);
  assertEquals(Hash.equals(sub[1], h('C')), true);
});

Deno.test('S4: linear aggregation - D aggregates C with anchor A', () => {
  const mod = buildModule(s4Blocks());
  const order = mod.totalOrdering(h('D'));
  assertEquals(order.length, 5);

  assertResolved(mod.resolveClaimIndex(h('D'), 0), { name: 'D', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 1), { name: 'C', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 2), { name: 'B', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 3), { name: 'A', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 4), { name: 'G', outputIndex: 0 });
});

Deno.test('S4: linear aggregation - outputSpace matches ground truth', () => {
  assertMatchesGroundTruth(s4Blocks(), 'D');
});

// -- S5: Multi-level G→{B→E, C→F}→AGG ----------------------------

function s5Blocks() {
  return [
    makeGenesis('G', 10),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [4] }),
    makeLeaf({ name: 'E', anchor: 'B', outputCount: 1, claimIndices: [] }),
    makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claimIndices: [3] }),
    makeLeaf({ name: 'F', anchor: 'C', outputCount: 1, claimIndices: [] }),
    makeAggregator({
      name: 'AGG',
      anchor: 'G',
      outputCount: 1,
      claimIndices: [],
      aggregates: ['E', 'F'],
      aggregateOutputCounts: [3, 3],
      newOutputCount: 7,
    }),
  ];
}

Deno.test('S5: multi-level aggregation - resolveClaimIndex', () => {
  const mod = buildModule(s5Blocks());

  assertResolved(mod.resolveClaimIndex(h('AGG'), 0), { name: 'AGG', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 1), { name: 'F', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 2), { name: 'C', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 3), { name: 'C', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 4), { name: 'E', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 5), { name: 'B', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 6), { name: 'B', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 7), { name: 'G', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('AGG'), 8), { name: 'G', outputIndex: 3 });
});

Deno.test('S5: multi-level aggregation - outputSpace matches ground truth', () => {
  assertMatchesGroundTruth(s5Blocks(), 'AGG');
});

Deno.test('S5: multi-level aggregation - computeClaimIndex round-trip', () => {
  const mod = buildModule(s5Blocks());
  const ext = mod.extendedVector(h('AGG'))!;
  for (let i = 0; i < ext.length; i++) {
    const resolved = mod.resolveClaimIndex(h('AGG'), i)!;
    assertEquals(mod.computeClaimIndex(h('AGG'), resolved), i, `Round-trip failed for index ${i}`);
  }
});

// -- S6: Self-claiming --------------------------------------------

Deno.test('S6: self-claiming - resolveClaimIndex', () => {
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [0, 1, 4] }),
  ]);

  assertResolved(mod.resolveClaimIndex(h('B'), 0), { name: 'B', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('B'), 1), { name: 'B', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('B'), 4), { name: 'G', outputIndex: 1 });
});

Deno.test('S6: self-claiming - subtreeClaimMask excludes self-claims', () => {
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [0, 1, 4] }),
  ]);
  assertEquals(mod.subtreeClaimMask(h('B')), [1]);
});

Deno.test('S6: self-claiming - outputSpace', () => {
  const mod = buildModule([
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [0, 1, 4] }),
  ]);
  const space = mod.outputSpace(h('B'))!;
  assertEquals(space.length, 5);
  assertResolved(space[0], { name: 'B', outputIndex: 2 });
  assertResolved(space[1], { name: 'G', outputIndex: 0 });
  assertResolved(space[2], { name: 'G', outputIndex: 2 });
  assertResolved(space[3], { name: 'G', outputIndex: 3 });
  assertResolved(space[4], { name: 'G', outputIndex: 4 });
});

Deno.test('S6: self-claiming - newOutputCount', () => {
  const B = makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [0, 1, 4] });
  assertEquals(B.newOutputCount, 1);
});

Deno.test('S6: self-claiming - outputSpace matches ground truth', () => {
  assertMatchesGroundTruth(
    [makeGenesis('G', 5), makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [0, 1, 4] })],
    'B',
  );
});

// -- S7: Self-claiming aggregate (parent navigates through) -------

function s7Blocks() {
  return [
    makeGenesis('G', 5),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [0] }),
    makeAggregator({
      name: 'D',
      anchor: 'G',
      outputCount: 1,
      claimIndices: [],
      aggregates: ['B'],
      aggregateOutputCounts: [2],
      newOutputCount: 3,
    }),
  ];
}

Deno.test('S7: self-claiming aggregate - resolveClaimIndex navigates past self-claims', () => {
  const mod = buildModule(s7Blocks());

  assertResolved(mod.resolveClaimIndex(h('D'), 0), { name: 'D', outputIndex: 0 });
  assertResolved(mod.resolveClaimIndex(h('D'), 1), { name: 'B', outputIndex: 1 });
  assertResolved(mod.resolveClaimIndex(h('D'), 2), { name: 'B', outputIndex: 2 });
  assertResolved(mod.resolveClaimIndex(h('D'), 3), { name: 'G', outputIndex: 0 });
});

Deno.test('S7: self-claiming aggregate - outputSpace matches ground truth', () => {
  assertMatchesGroundTruth(s7Blocks(), 'D');
});

Deno.test('S7: self-claiming aggregate - computeClaimIndex round-trip', () => {
  const mod = buildModule(s7Blocks());
  const ext = mod.extendedVector(h('D'))!;
  for (let i = 0; i < ext.length; i++) {
    const resolved = mod.resolveClaimIndex(h('D'), i)!;
    assertEquals(mod.computeClaimIndex(h('D'), resolved), i, `Round-trip failed for index ${i}`);
  }
});

// -- S8: Overlapping claims (conflict detection) ------------------

Deno.test('S8: overlapping claims detected', () => {
  const mod = buildModule([
    makeGenesis('G', 10),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [3] }),
    makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claimIndices: [2] }),
  ]);

  assertEquals(mod.subtreeClaimMask(h('B')), [0]);
  assertEquals(mod.subtreeClaimMask(h('C')), [0]);
  assertEquals(claimMasksOverlap([0], [0]), true);
});

Deno.test('S8: non-overlapping claims', () => {
  const mod = buildModule([
    makeGenesis('G', 10),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 3, claimIndices: [3] }),
    makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claimIndices: [3] }),
  ]);

  assertEquals(mod.subtreeClaimMask(h('B')), [0]);
  assertEquals(mod.subtreeClaimMask(h('C')), [1]);
  assertEquals(claimMasksOverlap([0], [1]), false);
});

// -- Rebase claim mask tests --------------------------------------

// Chain: G(5 outputs) → A → B → C, each claiming the previous block's output 0.
// A claims G:0, B claims A:0, C claims B:0.
function rebaseChainBlocks() {
  return [
    makeGenesis('G', 5),
    // A: 2 outputs, claims extended index 2 → anchor (G) output 0
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [2] }),
    // B: 2 outputs, claims extended index 2 → anchor (A) output 0 (A's own output)
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 2, claimIndices: [2] }),
    // C: 2 outputs, claims extended index 2 → anchor (B) output 0 (B's own output)
    makeLeaf({ name: 'C', anchor: 'B', outputCount: 2, claimIndices: [2] }),
  ];
}

Deno.test('rebaseClaimMask: direct anchor returns subtreeClaimMask unchanged', () => {
  const mod = buildModule(rebaseChainBlocks());
  // A anchors to G, so rebase to G needs no walk
  assertEquals(mod.rebaseClaimMask(h('A'), h('G')), [0]);
  assertEquals(mod.rebaseClaimMaskExclusive(h('A'), h('G')), [0]);
});

Deno.test('rebaseClaimMask: full rebase accumulates intermediate claims', () => {
  const mod = buildModule(rebaseChainBlocks());
  // B claims A:0 (A's own output). Full rebase walks through A and adds A's claims.
  // A claims G:0, so full rebase = [0] (A's claim, since B's own claim doesn't pass through).
  assertEquals(mod.rebaseClaimMask(h('B'), h('G')), [0]);
  // C claims B:0 (B's own output). Full rebase walks through B then A.
  // Picks up A's claims from the walk.
  assertEquals(mod.rebaseClaimMask(h('C'), h('G')), [0]);
});

Deno.test('rebaseClaimMaskExclusive: chain claims do not accumulate', () => {
  const mod = buildModule(rebaseChainBlocks());
  // B claims A:0 -- that's A's own output (index 0 < A.newOutputCount=2).
  // filterAboveAndShift removes it. Nothing passes through to G.
  // Exclusive rebase does NOT add A's own claims → result is empty.
  assertEquals(mod.rebaseClaimMaskExclusive(h('B'), h('G')), []);
  // Same for C: claims B:0 (B's own output), nothing reaches G.
  assertEquals(mod.rebaseClaimMaskExclusive(h('C'), h('G')), []);
});

Deno.test('rebaseClaimMaskExclusive: claim on inherited output passes through', () => {
  // G(5) → A(2 outputs, claims G:0) → B(1 output, claims A:2 which is G:1 surviving)
  // B claims an output inherited from G through A.
  const blocks = [
    makeGenesis('G', 5),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [2] }),
    // B: 1 output, claims extended index 3 → A's surviving index 2.
    // A's output space: [A:0, A:1, G:1, G:2, G:3, G:4] (G:0 was claimed).
    // A surviving index 2 = G:1.
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 1, claimIndices: [3] }),
  ];
  const mod = buildModule(blocks);

  // B's subtreeClaimMask against A = [2] (surviving index 2 of A's output space)
  assertEquals(mod.subtreeClaimMask(h('B')), [2]);

  // Full rebase: B claims A's surviving index 2. filterAboveAndShift([2], 2) = [0].
  // mapSurvivingToOriginalBatch([0], A's claimMask=[0]) → original index 1.
  // Then union with A's claims [0] → [0, 1].
  assertEquals(mod.rebaseClaimMask(h('B'), h('G')), [0, 1]);

  // Exclusive rebase: same projection but without adding A's claims → [1].
  assertEquals(mod.rebaseClaimMaskExclusive(h('B'), h('G')), [1]);
});

Deno.test('rebaseClaimMaskExclusive: independent subtrees match full rebase', () => {
  // When blocks anchor directly to the target, exclusive = full (no walk).
  const blocks = [
    makeGenesis('G', 10),
    makeLeaf({ name: 'B', anchor: 'G', outputCount: 2, claimIndices: [4] }),
    makeLeaf({ name: 'C', anchor: 'G', outputCount: 2, claimIndices: [3] }),
  ];
  const mod = buildModule(blocks);

  assertEquals(mod.rebaseClaimMask(h('B'), h('G')), [2]);
  assertEquals(mod.rebaseClaimMaskExclusive(h('B'), h('G')), [2]);
  assertEquals(mod.rebaseClaimMask(h('C'), h('G')), [1]);
  assertEquals(mod.rebaseClaimMaskExclusive(h('C'), h('G')), [1]);
});

Deno.test('rebaseClaimMaskExclusive: multi-hop walk projects correctly', () => {
  // G(10) → A(2 outputs, claims G:0) → B(2 outputs, claims inherited G:1 via A)
  // B claims an output that originated at G and passes through A.
  const blocks = [
    makeGenesis('G', 10),
    makeLeaf({ name: 'A', anchor: 'G', outputCount: 2, claimIndices: [2] }),
    // B: claims extended index 4 → A surviving index 2 → G original index 1
    makeLeaf({ name: 'B', anchor: 'A', outputCount: 2, claimIndices: [4] }),
  ];
  const mod = buildModule(blocks);

  // A: direct anchor to G, no walk needed -- both variants identical.
  assertEquals(mod.rebaseClaimMask(h('A'), h('G')), [0]);
  assertEquals(mod.rebaseClaimMaskExclusive(h('A'), h('G')), [0]);

  // B: claims A output space index 2 (G:1 inherited through A).
  // Full rebase: B's projected claim [1] plus A's claim [0] → [0, 1].
  assertEquals(mod.rebaseClaimMask(h('B'), h('G')), [0, 1]);
  // Exclusive: only B's projected claim → [1].
  assertEquals(mod.rebaseClaimMaskExclusive(h('B'), h('G')), [1]);
});

// -- Genesis edge case --------------------------------------------

Deno.test('genesis block has trivial output space', () => {
  const mod = buildModule([makeGenesis('G', 5)]);
  const space = mod.outputSpace(h('G'))!;
  assertEquals(space.length, 5);
  for (let i = 0; i < 5; i++) {
    assertResolved(space[i], { name: 'G', outputIndex: i });
  }
});

Deno.test('totalOrdering for genesis is just [genesis]', () => {
  const mod = buildModule([makeGenesis('G', 5)]);
  const order = mod.totalOrdering(h('G'));
  assertEquals(order.length, 1);
  assertEquals(Hash.equals(order[0], h('G')), true);
});
