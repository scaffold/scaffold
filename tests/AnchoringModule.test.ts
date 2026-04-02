import { assert, assertEquals } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { AnchoringModule, AnchoringProvider } from '../src/core/AnchoringModule.ts';
import {
  mapOriginalToSurviving,
  mapSurvivingToOriginal,
} from '../src/core/OutputSpace.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  ownOutputCount: number;
  outputCount: number;
  claimMask: readonly number[] | null;
  ownClaims: number[];
  aggregates: Hash[];
  aggregateOutputCounts: number[];
}

class TestProvider implements AnchoringProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();
  private aggregators = new Map<HashPrimitive, Hash[]>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
    for (const agg of block.aggregates) {
      const key = agg.toPrimitive();
      const existing = this.aggregators.get(key) ?? [];
      existing.push(block.hash);
      this.aggregators.set(key, existing);
    }
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }
  getHash(block: TestBlock): Hash {
    return block.hash;
  }
  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }
  getOwnOutputCount(block: TestBlock): number {
    return block.ownOutputCount;
  }
  getOutputCount(block: TestBlock): number {
    return block.outputCount;
  }
  getClaimMask(block: TestBlock): readonly number[] | null {
    return block.claimMask;
  }
  getOwnClaims(block: TestBlock): number[] {
    return block.ownClaims;
  }
  getAggregates(block: TestBlock): Hash[] {
    return block.aggregates;
  }
  getAggregateOutputCounts(block: TestBlock): number[] {
    return block.aggregateOutputCounts;
  }
  getAggregatorsOf(hash: Hash): Hash[] {
    return this.aggregators.get(hash.toPrimitive()) ?? [];
  }
}

const h = (name: string): Hash => Hash.digest(name);

function setup(): { provider: TestProvider; module: AnchoringModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new AnchoringModule(provider);
  return { provider, module };
}

function genesisBlock(hash: Hash, outputCount: number): TestBlock {
  return {
    hash,
    anchor: ZERO_HASH,
    ownOutputCount: outputCount,
    outputCount,
    claimMask: null,
    ownClaims: [],
    aggregates: [],
    aggregateOutputCounts: [],
  };
}

function leafBlock(opts: {
  hash: Hash;
  anchor: Hash;
  ownOutputCount: number;
  anchorOutputCount: number;
  claimIndices?: number[];
}): TestBlock {
  const claimIndices = opts.claimIndices ?? [];
  const outputCount = opts.anchorOutputCount - claimIndices.length + opts.ownOutputCount;
  return {
    hash: opts.hash,
    anchor: opts.anchor,
    ownOutputCount: opts.ownOutputCount,
    outputCount,
    claimMask: null,
    ownClaims: claimIndices,
    aggregates: [],
    aggregateOutputCounts: [],
  };
}

// -- mapSurvivingToOriginal tests --------------------------------

Deno.test('mapSurvivingToOriginal: no claims -- identity mapping', () => {
  const mask: number[] = [];
  assertEquals(mapSurvivingToOriginal(0, mask), 0);
  assertEquals(mapSurvivingToOriginal(1, mask), 1);
  assertEquals(mapSurvivingToOriginal(4, mask), 4);
});

Deno.test('mapSurvivingToOriginal: some claims', () => {
  const mask = [1, 3];
  // Surviving: 0, 2, 4
  assertEquals(mapSurvivingToOriginal(0, mask), 0);
  assertEquals(mapSurvivingToOriginal(1, mask), 2);
  assertEquals(mapSurvivingToOriginal(2, mask), 4);
});

Deno.test('mapSurvivingToOriginal: all claimed', () => {
  const mask = [0, 1, 2];
  // No surviving indices -- mapSurvivingToOriginal(0, mask) would return
  // an out-of-range value since there are no surviving slots.
  // The OutputSpace version returns the next original index after all claims.
  assertEquals(mapSurvivingToOriginal(0, mask), 3);
});

// -- mapOriginalToSurviving tests --------------------------------

Deno.test('mapOriginalToSurviving: no claims -- identity', () => {
  const mask: number[] = [];
  assertEquals(mapOriginalToSurviving(0, mask), 0);
  assertEquals(mapOriginalToSurviving(4, mask), 4);
});

Deno.test('mapOriginalToSurviving: claimed index returns -1', () => {
  const mask = [1, 3];
  assertEquals(mapOriginalToSurviving(1, mask), -1);
  assertEquals(mapOriginalToSurviving(3, mask), -1);
});

Deno.test('mapOriginalToSurviving: unclaimed indices mapped correctly', () => {
  const mask = [1, 3];
  assertEquals(mapOriginalToSurviving(0, mask), 0);
  assertEquals(mapOriginalToSurviving(2, mask), 1);
  assertEquals(mapOriginalToSurviving(4, mask), 2);
});

// -- Round-trip tests --------------------------------------------

Deno.test('round-trip: mapOriginalToSurviving(mapSurvivingToOriginal(i)) = identity', () => {
  const mask = [2, 5, 7];
  for (let i = 0; i < 5; i++) {
    const original = mapSurvivingToOriginal(i, mask);
    const roundTrip = mapOriginalToSurviving(original, mask);
    assertEquals(roundTrip, i);
  }
});

// -- rebaseOutputIndex: T1 - simple forward ----------------------

Deno.test('T1: simple forward rebase through one block', () => {
  // Genesis: [g0, g1, g2]. A anchors to Genesis: [a0], claimMask=[0,1,0]
  // A's output space: [a0, g0, g2]
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 3);
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    ownOutputCount: 1,
    outputCount: 3,
    claimMask: [1],
    ownClaims: [1],
    aggregates: [],
    aggregateOutputCounts: [],
  };
  provider.add(G);
  provider.add(A);

  assertEquals(module.rebaseOutputIndex(G.hash, 0, A.hash), 1); // g0 -> index 1
  assertEquals(module.rebaseOutputIndex(G.hash, 1, A.hash), null); // g1 consumed
  assertEquals(module.rebaseOutputIndex(G.hash, 2, A.hash), 2); // g2 -> index 2
});

// -- T2: forward through two blocks -----------------------------

Deno.test('T2: forward rebase through two blocks', () => {
  // Genesis: [g0, g1]. A: [a0], no claims. B: [b0], claims a0 at index 0.
  // A's space: [a0, g0, g1]. B's space: [b0, a0, g0, g1] minus a0 -> [b0, g0, g1]
  // Wait: B has no claimMask (leaf), ownClaims=[0]. The claimMask is for subtrees.
  // Forward anchor step uses claimMask. For leaf B, claimMask is null.
  // So all of A's outputs survive into B, placed after B's own.
  // B's output space: [b0, a0, g0, g1]. B's ownClaims removes position 0 at post-claim.
  // But rebaseOutputIndex maps to pre-claim (output space), not post-claim.
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  const B = leafBlock({
    hash: h('B'),
    anchor: A.hash,
    ownOutputCount: 1,
    anchorOutputCount: 3,
    claimIndices: [0],
  });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  // g0 -> A: index 1. Then A -> B: index 1 survives, result = 1 + 0 + 1 = 2.
  assertEquals(module.rebaseOutputIndex(G.hash, 0, B.hash), 2);
  // g1 -> A: index 2. Then A -> B: result = 1 + 0 + 2 = 3.
  assertEquals(module.rebaseOutputIndex(G.hash, 1, B.hash), 3);
});

// -- T3: backward rebase ----------------------------------------

Deno.test('T3: backward rebase', () => {
  // Genesis: [g0, g1, g2]. A: [a0], claimMask=[0,1,0]. A's space: [a0, g0, g2].
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 3);
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    ownOutputCount: 1,
    outputCount: 3,
    claimMask: [1],
    ownClaims: [1],
    aggregates: [],
    aggregateOutputCounts: [],
  };
  provider.add(G);
  provider.add(A);

  // a0 is A's own output -> doesn't exist in Genesis
  assertEquals(module.rebaseOutputIndex(A.hash, 0, G.hash), null);
  // Forward checks: g0 -> A = 1, g2 -> A = 2
  assertEquals(module.rebaseOutputIndex(G.hash, 0, A.hash), 1);
  assertEquals(module.rebaseOutputIndex(G.hash, 2, A.hash), 2);
});

// -- T4: forward through aggregation (independent subtrees) ------

Deno.test('T4: forward through aggregation', () => {
  // Genesis: [g0, g1]. S1 claims g0, S2 claims g1. D aggregates [S1, S2].
  // D's space: [d0, <S2 section: s2_0, g0>, <S1 section: s1_0, g1>]
  // Wait: S2 claims g1, so S2's surviving genesis = [g0]. S2 space = [s2_0, g0].
  // S1 claims g0, surviving = [g1]. S1 space = [s1_0, g1].
  // D.claimMask = [1,1] (both genesis outputs covered). No surviving genesis.
  // D's space: [d0, s2_0, g0, s1_0, g1] = 5 outputs.
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const S1: TestBlock = {
    hash: h('S1'), anchor: G.hash, ownOutputCount: 1, outputCount: 2,
    claimMask: null, ownClaims: [1], aggregates: [], aggregateOutputCounts: [],
  };
  const S2: TestBlock = {
    hash: h('S2'), anchor: G.hash, ownOutputCount: 1, outputCount: 2,
    claimMask: null, ownClaims: [1], aggregates: [], aggregateOutputCounts: [],
  };
  const D: TestBlock = {
    hash: h('D'), anchor: G.hash, ownOutputCount: 1, outputCount: 5,
    claimMask: [0, 1], ownClaims: [],
    aggregates: [S1.hash, S2.hash], aggregateOutputCounts: [2, 2],
  };
  provider.add(G);
  provider.add(S1);
  provider.add(S2);
  provider.add(D);

  // S1's own output -> D: offset = 1 + aggOutputCounts[1]=2 = 3. result = 3 + 0 = 3.
  assertEquals(module.rebaseOutputIndex(S1.hash, 0, D.hash), 3);
  // S2's own output -> D: offset = 1 + 0 = 1. result = 1 + 0 = 1.
  assertEquals(module.rebaseOutputIndex(S2.hash, 0, D.hash), 1);
});

// -- T5: aggregation with chained subtrees -----------------------

Deno.test('T5: aggregation with chained subtrees', () => {
  // Genesis: [g0, g1, g2]. B anchors to Genesis: [b0, b1], claims g0.
  // C anchors to B: [c0], claims b0.
  // D aggregates [B, C], anchor = Genesis.
  // C chains from B. Chained section = C.outputCount = 4: [c0, b1, g1, g2].
  // D.claimMask = [1,1,1] (all genesis covered). D's space: [d0, c0, b1, g1, g2].
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 3);
  const B: TestBlock = {
    hash: h('B'), anchor: G.hash, ownOutputCount: 2, outputCount: 4,
    claimMask: null, ownClaims: [2], aggregates: [], aggregateOutputCounts: [],
  };
  const C: TestBlock = {
    hash: h('C'), anchor: B.hash, ownOutputCount: 1, outputCount: 4,
    claimMask: null, ownClaims: [1], aggregates: [], aggregateOutputCounts: [],
  };
  const D: TestBlock = {
    hash: h('D'), anchor: G.hash, ownOutputCount: 1, outputCount: 5,
    claimMask: [0, 1, 2], ownClaims: [],
    aggregates: [B.hash, C.hash], aggregateOutputCounts: [4, 4],
  };
  provider.add(G);
  provider.add(B);
  provider.add(C);
  provider.add(D);

  // b1 -> D: at index 2 in [d0, c0, b1, g1, g2]
  assertEquals(module.rebaseOutputIndex(B.hash, 1, D.hash), 2);
  // c0 -> D: at index 1
  assertEquals(module.rebaseOutputIndex(C.hash, 0, D.hash), 1);
});

// -- T10: backward through aggregation ---------------------------

Deno.test('T10: forward through single-subtree aggregation', () => {
  // Genesis: [g0, g1]. S1: [s1_0], claims g0. D aggregates [S1].
  // S1 covers all genesis outputs (g0 claimed, g1 passed through).
  // D.claimMask = [1,1]. D's space: [d0, s1_0, g1] = 3.
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const S1: TestBlock = {
    hash: h('S1'), anchor: G.hash, ownOutputCount: 1, outputCount: 2,
    claimMask: null, ownClaims: [1], aggregates: [], aggregateOutputCounts: [],
  };
  const D: TestBlock = {
    hash: h('D'), anchor: G.hash, ownOutputCount: 1, outputCount: 3,
    claimMask: [0, 1], ownClaims: [],
    aggregates: [S1.hash], aggregateOutputCounts: [2],
  };
  provider.add(G);
  provider.add(S1);
  provider.add(D);

  // d0 -> S1: D's own output doesn't exist in S1. null.
  assertEquals(module.rebaseOutputIndex(D.hash, 0, S1.hash), null);
  // s1_0 -> D: at index 1
  assertEquals(module.rebaseOutputIndex(S1.hash, 0, D.hash), 1);
});

// -- T11: bidirectional between siblings -------------------------

Deno.test('T11: bidirectional rebase between siblings', () => {
  // Genesis: [g0]. A: [a0]. B: [b0]. Both anchor to Genesis.
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 1);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 1 });
  const B = leafBlock({ hash: h('B'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 1 });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  // a0 -> B: a0 is A's own output, backward step returns null
  assertEquals(module.rebaseOutputIndex(A.hash, 0, B.hash), null);
  // g0 -> B: forward, result = 1
  assertEquals(module.rebaseOutputIndex(G.hash, 0, B.hash), 1);
  // g0 -> A: forward, result = 1
  assertEquals(module.rebaseOutputIndex(G.hash, 0, A.hash), 1);
});

// -- Additional tests --------------------------------------------

Deno.test('output consumed by intermediate block returns null', () => {
  // Genesis: [g0, g1]. A: [a0], claimMask=[1,0] (claims g0). B: [b0] anchors to A.
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A: TestBlock = {
    hash: h('A'), anchor: G.hash, ownOutputCount: 1, outputCount: 2,
    claimMask: [0], ownClaims: [1],
    aggregates: [], aggregateOutputCounts: [],
  };
  const B = leafBlock({ hash: h('B'), anchor: A.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  assertEquals(module.rebaseOutputIndex(G.hash, 0, B.hash), null); // g0 consumed by A
  assertEquals(module.rebaseOutputIndex(G.hash, 1, B.hash), 2); // g1 survives
});

Deno.test('genesis outputs: direct mapping when target is genesis', () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 3);
  provider.add(G);
  assertEquals(module.rebaseOutputIndex(G.hash, 0, G.hash), 0);
  assertEquals(module.rebaseOutputIndex(G.hash, 1, G.hash), 1);
  assertEquals(module.rebaseOutputIndex(G.hash, 2, G.hash), 2);
});

Deno.test("self-claimed output: A's own output at same block", () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A = leafBlock({
    hash: h('A'), anchor: G.hash, ownOutputCount: 2,
    anchorOutputCount: 2, claimIndices: [0],
  });
  provider.add(G);
  provider.add(A);
  assertEquals(module.rebaseOutputIndex(A.hash, 0, A.hash), 0);
  assertEquals(module.rebaseOutputIndex(A.hash, 1, A.hash), 1);
});

Deno.test('multi-hop forward chain', () => {
  // Genesis: [g0]. A: [a0]. B: [b0]. C: [c0]. No claims.
  // C's space: [c0, b0, a0, g0]. g0 at index 3.
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 1);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 1 });
  const B = leafBlock({ hash: h('B'), anchor: A.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  const C = leafBlock({ hash: h('C'), anchor: B.hash, ownOutputCount: 1, anchorOutputCount: 3 });
  provider.add(G);
  provider.add(A);
  provider.add(B);
  provider.add(C);

  assertEquals(module.rebaseOutputIndex(G.hash, 0, C.hash), 3);
  assertEquals(module.rebaseOutputIndex(A.hash, 0, C.hash), 2);
});

// -- resolveAnchor tests -----------------------------------------

Deno.test('resolveAnchor: single include block -> anchor = that block', () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 3);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 3 });
  provider.add(G);
  provider.add(A);

  const result = module.resolveAnchor({
    includeBlocks: [A.hash],
    excludeBlocks: [],
    declaredWeight: 1,
  });
  assert(!('error' in result));
  assert(Hash.equals(result.anchor, A.hash));
  assertEquals(result.aggregates.length, 0);
});

Deno.test('T9: two blocks on same chain -> anchor = deeper block', () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  const B = leafBlock({ hash: h('B'), anchor: A.hash, ownOutputCount: 1, anchorOutputCount: 3 });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  const result = module.resolveAnchor({
    includeBlocks: [G.hash, B.hash],
    excludeBlocks: [],
    declaredWeight: 1,
  });
  assert(!('error' in result));
  assert(Hash.equals(result.anchor, B.hash));
  assertEquals(result.aggregates.length, 0);
});

Deno.test('T9: two blocks on different branches -> aggregation required', () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  const B = leafBlock({ hash: h('B'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  const result = module.resolveAnchor({
    includeBlocks: [A.hash, B.hash],
    excludeBlocks: [],
    declaredWeight: 1,
  });
  assert(!('error' in result));
  // LCA = Genesis. Both A and B are side branches. Both become aggregates.
  assertEquals(result.aggregates.length, 2);
  // Anchor should be LCA (Genesis)
  assert(Hash.equals(result.anchor, G.hash));
});

Deno.test('T7: exclude constraint forces shallower anchor', () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  const B = leafBlock({ hash: h('B'), anchor: A.hash, ownOutputCount: 1, anchorOutputCount: 3 });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  // Include Genesis, exclude A. Genesis itself is valid (not descendant of A).
  const result = module.resolveAnchor({
    includeBlocks: [G.hash],
    excludeBlocks: [A.hash],
    declaredWeight: 1,
  });
  assert(!('error' in result));
  assert(Hash.equals(result.anchor, G.hash));
});

Deno.test('T8: include/exclude conflict -> error', () => {
  const { provider, module } = setup();
  const G = genesisBlock(h('G'), 2);
  const A = leafBlock({ hash: h('A'), anchor: G.hash, ownOutputCount: 1, anchorOutputCount: 2 });
  const B = leafBlock({ hash: h('B'), anchor: A.hash, ownOutputCount: 1, anchorOutputCount: 3 });
  provider.add(G);
  provider.add(A);
  provider.add(B);

  // Include B but exclude A. B requires A as ancestor -- infeasible.
  const result = module.resolveAnchor({
    includeBlocks: [B.hash],
    excludeBlocks: [A.hash],
    declaredWeight: 1,
  });
  assert('error' in result);
});
