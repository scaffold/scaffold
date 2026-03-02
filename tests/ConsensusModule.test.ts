import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { ConsensusModule, ConsensusProvider } from '../src/ConsensusModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor?: Hash;
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

  getAnchor(block: TestBlock): Hash | undefined {
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
  const { layer } = setup(G);

  assert(layer.isCanonical(G.hash));
  assertEquals(layer.getEffectiveWeight(G.hash), 0);
  assertEquals(layer.getCanonicalView().size, 1);
  assert(layer.getCanonicalView().has(G.hash.toPrimitive()));
});

Deno.test({ name: 'simple chain with no conflicts: all blocks canonical' }, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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

Deno.test({ name: 'aggregation creates conflict with aggregated block' }, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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

  // C aggregates A -> C conflicts with A
  const conflicts = layer.getConflicts(C.hash);
  assert(conflicts.has(A.hash.toPrimitive()));

  // C wins (60 > 50)
  assert(layer.isCanonical(C.hash));
  assertFalse(layer.isCanonical(A.hash));
});

Deno.test({
  name: 'aggregation inherits conflicts from aggregated block',
}, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  // C aggregates A -> C inherits A's conflict with B
  layer.setVerifiedWeight(C.hash, [70]);
  layer.setVerifiedWeight(B.hash, [40]);

  const cConflicts = layer.getConflicts(C.hash);
  assert(cConflicts.has(B.hash.toPrimitive()), 'C should inherit conflict with B');
  assert(cConflicts.has(A.hash.toPrimitive()), 'C should conflict with A (aggregation)');
});

Deno.test({ name: 'conflict propagates forward along anchor chain' }, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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

  // X conflicts with Y, Z anchors to Y -> X conflicts with Z
  const xConflicts = layer.getConflicts(X.hash);
  assert(xConflicts.has(Z.hash.toPrimitive()), 'X should conflict with Z (propagation)');

  const zConflicts = layer.getConflicts(Z.hash);
  assert(zConflicts.has(X.hash.toPrimitive()), 'Z should conflict with X (symmetric)');
});

Deno.test({
  name: 'conflict does NOT propagate backward through anchor',
}, () => {
  const W: TestBlock = { hash: h('W'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  // F anchors to B, B lost -> F conflicts with A (propagation) -> F excluded
  assertFalse(layer.isCanonical(F.hash));
});

Deno.test({ name: 'uncontested block always canonical' }, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  name: 'multiple aggregates with inheritance from both',
}, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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

  const sConflicts = layer.getConflicts(S.hash);

  // S aggregates A1 and A2 -> conflicts with both
  assert(sConflicts.has(A1.hash.toPrimitive()));
  assert(sConflicts.has(A2.hash.toPrimitive()));

  // S inherits A1's conflict with B1 and A2's conflict with B2
  assert(sConflicts.has(B1.hash.toPrimitive()), 'S should inherit A1 conflict with B1');
  assert(sConflicts.has(B2.hash.toPrimitive()), 'S should inherit A2 conflict with B2');
});

Deno.test({
  name: 'full spec example: genesis, 3 blocks, descendants, weight changes',
}, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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

Deno.test({
  name: 'getDescendantWeight: weight vector attributes to correct chain level',
}, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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

  layer.setVerifiedWeight(C1.hash, [5]);
  layer.setVerifiedWeight(B.hash, [10, 20, 30]);

  // B's anchor chain: B -> C1 -> G
  // B.weight[0] = 10 -> attributed to C1 (direct anchor)
  // B.weight[1] = 20 -> attributed to G (anchor's anchor)
  // B.weight[2] = 30 -> beyond genesis, attributed to nothing
  assertEquals(layer.getDescendantWeight(C1.hash), 10);
  // G gets: C1.weight[0] (=5) + B.weight[1] (=20) = 25
  assertEquals(layer.getDescendantWeight(G.hash), 25);
});

Deno.test({
  name: 'dynamic conflict discovery updates canonical view',
}, () => {
  const G: TestBlock = { hash: h('G'), aggregates: [], weight: [] };
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
