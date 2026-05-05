import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { ConsensusModule, ConsensusProvider } from '../src/core/ConsensusModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  aggregates: Hash[];
  weight: number[];
}

class TestProvider implements ConsensusProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
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

  getAggregates(block: TestBlock): Hash[] {
    return block.aggregates;
  }

  getWeightVector(block: TestBlock): number[] {
    return block.weight;
  }
}

/** Create a named hash deterministically from a string. */
const h = (name: string): Hash => Hash.digest(name);

/** Helper to set up provider + layer and register blocks. */
function setup(...blocks: TestBlock[]): {
  provider: TestProvider;
  layer: ConsensusModule<TestBlock>;
} {
  const provider = new TestProvider();
  const layer = new ConsensusModule(provider);
  for (const block of blocks) {
    provider.add(block);
    layer.addBlock(block.hash);
  }
  return { provider, layer };
}

// -- Tests -------------------------------------------------------

Deno.test({ name: 'genesis only: single block is canonical with zero weight' }, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const { layer } = setup(G);

  assert(layer.isCanonical(G.hash));
  assertEquals(layer.getEffectiveWeight(G.hash), 0);
  assertEquals(layer.getCanonicalView().size, 1);
  assert(layer.getCanonicalView().has(G.hash.toPrimitive()));
});

Deno.test({ name: 'simple chain with no conflicts: all blocks canonical' }, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: A.hash,
    aggregates: [],
    weight: [30],
  };
  const { layer } = setup(G, A, B);

  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(B.hash, [30]);

  assert(layer.isCanonical(G.hash));
  assert(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
  assertEquals(layer.getCanonicalView().size, 3);
});

Deno.test({ name: 'basic conflict: higher verified weight wins' }, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const { layer } = setup(G, A, B);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [90]);
  layer.setVerifiedWeight(B.hash, [80]);

  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  assertEquals(layer.getEffectiveWeight(A.hash), 90);
  assertEquals(layer.getEffectiveWeight(B.hash), 80);
});

Deno.test({
  name: 'descendant weight flips conflict winner',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [90],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const D: TestBlock = {
    hash: h('D'),
    anchor: B.hash,
    aggregates: [],
    weight: [200],
  };
  const E: TestBlock = {
    hash: h('E'),
    anchor: A.hash,
    aggregates: [],
    weight: [50],
  };
  const { layer } = setup(G, A, B, D, E);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [90]);
  layer.setVerifiedWeight(B.hash, [80]);
  layer.setVerifiedWeight(D.hash, [200]);
  layer.setVerifiedWeight(E.hash, [50]);

  // B wins: 80 + 200 = 280 vs A: 90 + 50 = 140
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
  assertEquals(layer.getEffectiveWeight(B.hash), 280);
  assertEquals(layer.getEffectiveWeight(A.hash), 140);
});

Deno.test({ name: 'aggregation does not create implicit conflict' }, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: G.hash,
    aggregates: [A.hash],
    weight: [60],
  };
  const { layer } = setup(G, A, C);

  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(C.hash, [60]);

  // Aggregation no longer creates an implicit conflict between C and A
  const conflicts = layer.getConflicts(C.hash);
  assertFalse(conflicts.has(A.hash.toPrimitive()));

  // Both should be canonical (no conflict between them)
  assert(layer.isCanonical(A.hash));
  assert(layer.isCanonical(C.hash));
});

Deno.test({
  name: 'aggregation does not inherit conflicts from aggregated block',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [40],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: G.hash,
    aggregates: [A.hash],
    weight: [70],
  };
  const { layer } = setup(G, A, B, C);

  // A conflicts with B (direct)
  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(C.hash, [70]);
  layer.setVerifiedWeight(B.hash, [40]);

  // C does NOT inherit A's conflicts -- no transitive conflict inheritance
  const cConflicts = layer.getConflicts(C.hash);
  assertFalse(cConflicts.has(B.hash.toPrimitive()), 'C should NOT inherit conflict with B');
  assertFalse(cConflicts.has(A.hash.toPrimitive()), 'C should NOT conflict with A');

  // A wins its conflict with B (50 > 40), C aggregates A (canonical), so C is canonical
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  assert(layer.isCanonical(C.hash));
});

Deno.test({ name: 'conflict does NOT propagate forward along anchor chain' }, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const X: TestBlock = {
    hash: h('X'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const Y: TestBlock = {
    hash: h('Y'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const Z: TestBlock = {
    hash: h('Z'),
    anchor: Y.hash,
    aggregates: [],
    weight: [30],
  };
  const { layer } = setup(G, X, Y, Z);

  layer.addConflict(X.hash, Y.hash);
  layer.setVerifiedWeight(X.hash, [100]);
  layer.setVerifiedWeight(Y.hash, [50]);
  layer.setVerifiedWeight(Z.hash, [30]);

  // Conflicts are NOT propagated forward -- Z has no direct conflict with X
  const xConflicts = layer.getConflicts(X.hash);
  assertFalse(xConflicts.has(Z.hash.toPrimitive()), 'X should NOT conflict with Z');

  const zConflicts = layer.getConflicts(Z.hash);
  assertFalse(zConflicts.has(X.hash.toPrimitive()), 'Z should NOT conflict with X');

  // However, Z is still non-canonical because its anchor Y lost (Rule 1)
  assert(layer.isCanonical(X.hash));
  assertFalse(layer.isCanonical(Y.hash));
  assertFalse(layer.isCanonical(Z.hash));
});

Deno.test({
  name: 'conflict does NOT propagate backward through anchor',
}, () => {
  const W: TestBlock = { hash: h('W'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const Y: TestBlock = {
    hash: h('Y'),
    anchor: W.hash,
    aggregates: [],
    weight: [50],
  };
  const X: TestBlock = {
    hash: h('X'),
    anchor: W.hash,
    aggregates: [],
    weight: [100],
  };
  const { layer } = setup(W, Y, X);

  layer.addConflict(X.hash, Y.hash);

  // X conflicts with Y, Y anchors to W -> W is NOT in conflict with X
  const wConflicts = layer.getConflicts(W.hash);
  assertFalse(
    wConflicts.has(X.hash.toPrimitive()),
    'W should NOT conflict with X (no backward propagation)',
  );
});

Deno.test({
  name: 'conflict losers and their descendants excluded from canonical view',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const F: TestBlock = {
    hash: h('F'),
    anchor: B.hash,
    aggregates: [],
    weight: [30],
  };
  const { layer } = setup(G, A, B, F);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [100]);
  layer.setVerifiedWeight(B.hash, [50]);
  layer.setVerifiedWeight(F.hash, [30]);

  // A wins (100 > 50+30=80)
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  // F anchors to B, B is non-canonical -> F excluded (Rule 1: anchor must be canonical)
  assertFalse(layer.isCanonical(F.hash));
});

Deno.test({ name: 'uncontested block always canonical' }, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const { layer } = setup(G, A, B, C);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [100]);
  layer.setVerifiedWeight(B.hash, [80]);
  layer.setVerifiedWeight(C.hash, [50]);

  // C has no conflicts -> always canonical regardless of A vs B outcome
  assert(layer.isCanonical(C.hash));
});

Deno.test({ name: 'tie-breaking: equal weight, lower hash wins' }, () => {
  // Create two blocks with predictable hash ordering
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const { layer } = setup(G, A, B);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [100]);
  layer.setVerifiedWeight(B.hash, [100]);

  // Both have weight 100. Lower hash wins.
  const aLower = Hash.compare(A.hash, B.hash) < 0;
  if (aLower) {
    assert(layer.isCanonical(A.hash));
    assertFalse(layer.isCanonical(B.hash));
  } else {
    assert(layer.isCanonical(B.hash));
    assertFalse(layer.isCanonical(A.hash));
  }
});

Deno.test({
  name: 'setting verified weight changes conflict outcome',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [200],
  };
  const { layer } = setup(G, A, B);

  layer.addConflict(A.hash, B.hash);

  // Both unverified -> both zero weight. Winner by hash.
  const aPrim = A.hash.toPrimitive();
  const bPrim = B.hash.toPrimitive();
  const aLower = Hash.compare(A.hash, B.hash) < 0;
  const initialWinner = aLower ? aPrim : bPrim;
  assert(layer.getCanonicalView().has(initialWinner));

  // Now verify A with weight 100
  layer.setVerifiedWeight(A.hash, [100]);

  // A wins (100 > 0)
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));

  // Now verify B with weight 200
  layer.setVerifiedWeight(B.hash, [200]);

  // B wins (200 > 100)
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
});

Deno.test({
  name: 'removeConflict makes both blocks canonical',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const { layer } = setup(G, A, B);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [100]);
  layer.setVerifiedWeight(B.hash, [80]);

  // A wins, B excluded
  assertFalse(layer.isCanonical(B.hash));

  // Remove conflict -> both canonical
  layer.removeConflict(A.hash, B.hash);
  assert(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
});

Deno.test({
  name: 'unverified blocks have zero effective weight',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const { layer } = setup(G, A);

  // No verified weight set -> effective weight is 0
  assertEquals(layer.getEffectiveWeight(A.hash), 0);
});

Deno.test({
  name: 'deep chain: descendant weight contributes to ancestor effective weight',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [10],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: A.hash,
    aggregates: [],
    weight: [20],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: B.hash,
    aggregates: [],
    weight: [30],
  };
  const { layer } = setup(G, A, B, C);

  layer.setVerifiedWeight(A.hash, [10]);
  layer.setVerifiedWeight(B.hash, [20]);
  layer.setVerifiedWeight(C.hash, [30]);

  // effective_weight(A) = 10 + effective_weight(B) = 10 + (20 + effective_weight(C))
  // = 10 + 20 + 30 = 60
  assertEquals(layer.getEffectiveWeight(A.hash), 60);
  assertEquals(layer.getEffectiveWeight(B.hash), 50);
  assertEquals(layer.getEffectiveWeight(C.hash), 30);
});

Deno.test({
  name: 'multiple aggregates: no conflict inheritance, Rule 2 governs canonicality',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A1: TestBlock = {
    hash: h('A1'),
    anchor: G.hash,
    aggregates: [],
    weight: [10],
  };
  const A2: TestBlock = {
    hash: h('A2'),
    anchor: G.hash,
    aggregates: [],
    weight: [20],
  };
  const B1: TestBlock = {
    hash: h('B1'),
    anchor: G.hash,
    aggregates: [],
    weight: [5],
  };
  const B2: TestBlock = {
    hash: h('B2'),
    anchor: G.hash,
    aggregates: [],
    weight: [8],
  };
  const S: TestBlock = {
    hash: h('S'),
    anchor: G.hash,
    aggregates: [A1.hash, A2.hash],
    weight: [30],
  };
  const { layer } = setup(G, A1, A2, B1, B2, S);

  layer.addConflict(A1.hash, B1.hash); // A1 conflicts with B1
  layer.addConflict(A2.hash, B2.hash); // A2 conflicts with B2
  layer.setVerifiedWeight(A1.hash, [10]);
  layer.setVerifiedWeight(A2.hash, [20]);
  layer.setVerifiedWeight(B1.hash, [5]);
  layer.setVerifiedWeight(B2.hash, [8]);
  layer.setVerifiedWeight(S.hash, [30]);

  // S does NOT have any direct conflicts -- no inheritance
  const sConflicts = layer.getConflicts(S.hash);
  assertEquals(sConflicts.size, 0);

  // A1 wins over B1 (10 > 5), A2 wins over B2 (20 > 8)
  // Both aggregates are canonical, so S is canonical (Rule 2 satisfied)
  assert(layer.isCanonical(A1.hash));
  assert(layer.isCanonical(A2.hash));
  assert(layer.isCanonical(S.hash));
  assertFalse(layer.isCanonical(B1.hash));
  assertFalse(layer.isCanonical(B2.hash));
});

Deno.test({
  name: 'full spec example: genesis, 3 blocks, descendants, weight changes',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };

  const { provider, layer } = setup(G, A, B, C);

  layer.addConflict(A.hash, B.hash);

  // Initially unverified -> zero weight, tie by hash
  // After verification:
  layer.setVerifiedWeight(A.hash, [90]);
  layer.setVerifiedWeight(B.hash, [80]);
  layer.setVerifiedWeight(C.hash, [50]);

  // A wins (90 > 80), C always canonical
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  assert(layer.isCanonical(C.hash));

  // New blocks arrive
  const D: TestBlock = {
    hash: h('D'),
    anchor: B.hash,
    aggregates: [],
    weight: [200],
  };
  const E: TestBlock = {
    hash: h('E'),
    anchor: A.hash,
    aggregates: [],
    weight: [50],
  };
  provider.add(D);
  provider.add(E);
  layer.addBlock(D.hash);
  layer.addBlock(E.hash);

  layer.setVerifiedWeight(D.hash, [200]);
  layer.setVerifiedWeight(E.hash, [50]);

  // B: 80 + 200 = 280, A: 90 + 50 = 140 -> B overtakes
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
  assert(layer.isCanonical(C.hash));
  assert(layer.isCanonical(D.hash));
  assertFalse(layer.isCanonical(E.hash));

  // Fraud detection: D only 50% real
  layer.setVerifiedWeight(D.hash, [100]);

  // B: 80 + 100 = 180 vs A: 90 + 50 = 140 -> B still wins
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));
});

Deno.test({
  name: 'weight vector with multiple depths: sum for effective weight',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const C1: TestBlock = {
    hash: h('C1'),
    anchor: G.hash,
    aggregates: [],
    weight: [5],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: C1.hash,
    aggregates: [],
    weight: [10, 20, 30],
  };
  const { layer } = setup(G, C1, B);

  layer.setVerifiedWeight(B.hash, [10, 20, 30]);

  // Effective weight = sum of verified weight vector = 60
  assertEquals(layer.getEffectiveWeight(B.hash), 60);
});

// Note: chain-block descendant weight (the old getDescendantWeight) is now
// delegated to NodeWeightsService -- see tests/NodeWeightsService.test.ts and
// docs/protocol/weight-propagation.md. Conflict-resolution scoring still
// flows through ConsensusModule via the optional `effectiveWeight` callback.

// -- removeBlock tests --------------------------------------------

Deno.test('removeBlock: removes from canonical view', () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
  const { layer } = setup(G, A);

  layer.setVerifiedWeight(A.hash, [50]);
  assert(layer.isCanonical(A.hash));
  assertEquals(layer.getCanonicalView().size, 2);

  layer.removeBlock(A.hash);
  assertEquals(layer.getCanonicalView().size, 1);
  assert(layer.isCanonical(G.hash));
});

Deno.test('removeBlock: cleans up children map', () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
  const B: TestBlock = { hash: h('B'), anchor: A.hash, aggregates: [], weight: [30] };
  const { layer } = setup(G, A, B);

  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(B.hash, [30]);

  // B contributes to A's effective weight
  assertEquals(layer.getEffectiveWeight(A.hash), 80);

  layer.removeBlock(B.hash);
  assertEquals(layer.getEffectiveWeight(A.hash), 50);
});

Deno.test('removeBlock: cleans up aggregation maps', () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [80] };
  const S: TestBlock = { hash: h('S'), anchor: G.hash, aggregates: [A.hash], weight: [60] };
  const { layer } = setup(G, A, B, S);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(B.hash, [80]);
  layer.setVerifiedWeight(S.hash, [60]);

  // A loses to B (50 < 80), so S is non-canonical (Rule 2: aggregate A not canonical)
  assertFalse(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(S.hash));

  // Remove S -> aggregation edge cleaned up, A still loses conflict with B
  layer.removeBlock(S.hash);
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
});

Deno.test('removeBlock: unknown hash is no-op', () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const { layer } = setup(G);

  // Should not throw
  layer.removeBlock(Hash.digest('nonexistent'));
  assertEquals(layer.getCanonicalView().size, 1);
});

Deno.test('removeBlock: canonicality recalculates (may flip conflict winners)', () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [30] };
  const D: TestBlock = { hash: h('D'), anchor: B.hash, aggregates: [], weight: [100] };
  const { layer } = setup(G, A, B, D);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(B.hash, [30]);
  layer.setVerifiedWeight(D.hash, [100]);

  // B wins: 30 + 100 = 130 > 50
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));

  // Remove D -> A should win: 50 > 30
  layer.removeBlock(D.hash);
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
});

Deno.test({
  name: 'dynamic conflict discovery updates canonical view',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const { layer } = setup(G, A, B);

  layer.setVerifiedWeight(A.hash, [100]);
  layer.setVerifiedWeight(B.hash, [80]);

  // No conflict yet -> both canonical
  assert(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));

  // Conflict discovered later
  layer.addConflict(A.hash, B.hash);

  // Now A wins
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
});

// -- Rule 1/2 propagation tests -----------------------------------

Deno.test({
  name: 'anchor must be canonical: block with non-canonical anchor excluded',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [100],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [50],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: B.hash,
    aggregates: [],
    weight: [10],
  };
  const { layer } = setup(G, A, B, C);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [100]);
  layer.setVerifiedWeight(B.hash, [50]);
  layer.setVerifiedWeight(C.hash, [10]);

  // A wins (100 > 50+10=60), B is non-canonical
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  // C has no conflicts of its own, but its anchor B is non-canonical (Rule 1)
  assertFalse(layer.isCanonical(C.hash));
});

Deno.test({
  name: 'aggregated block must be canonical: aggregator excluded when aggregate loses',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [30],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: G.hash,
    aggregates: [A.hash],
    weight: [50],
  };
  const { layer } = setup(G, A, B, C);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [30]);
  layer.setVerifiedWeight(B.hash, [80]);
  layer.setVerifiedWeight(C.hash, [50]);

  // B wins conflict with A (80 > 30)
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));
  // C aggregates A, which is non-canonical -> C excluded (Rule 2)
  assertFalse(layer.isCanonical(C.hash));
});

Deno.test({
  name: 'non-canonical aggregate cascades to aggregator descendants',
}, () => {
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = {
    hash: h('A'),
    anchor: G.hash,
    aggregates: [],
    weight: [30],
  };
  const B: TestBlock = {
    hash: h('B'),
    anchor: G.hash,
    aggregates: [],
    weight: [80],
  };
  const C: TestBlock = {
    hash: h('C'),
    anchor: G.hash,
    aggregates: [A.hash],
    weight: [50],
  };
  const D: TestBlock = {
    hash: h('D'),
    anchor: C.hash,
    aggregates: [],
    weight: [20],
  };
  const { layer } = setup(G, A, B, C, D);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [30]);
  layer.setVerifiedWeight(B.hash, [80]);
  layer.setVerifiedWeight(C.hash, [50]);
  layer.setVerifiedWeight(D.hash, [20]);

  // B wins conflict with A (80 > 30)
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));
  // C aggregates A (non-canonical) -> C excluded (Rule 2)
  assertFalse(layer.isCanonical(C.hash));
  // D anchors to C (non-canonical) -> D excluded (Rule 1)
  assertFalse(layer.isCanonical(D.hash));
});

Deno.test({
  name: 'pairwise conflict: non-clique graph does not group unrelated blocks',
}, () => {
  // A ⚡ B and B ⚡ C, but NOT A ⚡ C.
  // B claims two outputs, each contested by a different block.
  // A and C should both be canonical; only B loses (if weaker than both).
  const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [30] };
  const C: TestBlock = { hash: h('C'), anchor: G.hash, aggregates: [], weight: [40] };
  const { layer } = setup(G, A, B, C);

  layer.addConflict(A.hash, B.hash); // A ⚡ B
  layer.addConflict(B.hash, C.hash); // B ⚡ C
  // No A ⚡ C conflict
  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(B.hash, [30]);
  layer.setVerifiedWeight(C.hash, [40]);

  // B loses to both A (50 > 30) and C (40 > 30)
  assertFalse(layer.isCanonical(B.hash));
  // A and C don't conflict -- both should be canonical
  assert(layer.isCanonical(A.hash));
  assert(layer.isCanonical(C.hash));
});
