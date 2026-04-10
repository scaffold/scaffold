import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { ConsensusModule, ConsensusProvider } from '../src/core/ConsensusModule.ts';

// -- Test helpers (same as ConsensusModule.test.ts) --------------------

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

const h = (name: string): Hash => Hash.digest(name);

function setup(
  blocks: TestBlock[],
  canonicalOnly: boolean,
): { provider: TestProvider; layer: ConsensusModule<TestBlock> } {
  const provider = new TestProvider();
  const layer = new ConsensusModule(provider, { canonicalOnlyWeight: canonicalOnly });
  for (const block of blocks) {
    provider.add(block);
    layer.addBlock(block.hash);
  }
  return { provider, layer };
}

// -- Blocks used across tests ----------------------------------------

const G: TestBlock = { hash: h('G'), anchor: ZERO_HASH, aggregates: [], weight: [] };

// =====================================================================
// Tests that should produce identical results in both modes
// =====================================================================

for (const canonicalOnly of [false, true]) {
  const mode = canonicalOnly ? 'canonical-only' : 'all-descendants';

  Deno.test(`[${mode}] no conflicts: all blocks canonical`, () => {
    const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
    const B: TestBlock = { hash: h('B'), anchor: A.hash, aggregates: [], weight: [30] };
    const { layer } = setup([G, A, B], canonicalOnly);

    layer.setVerifiedWeight(A.hash, [50]);
    layer.setVerifiedWeight(B.hash, [30]);

    assert(layer.isCanonical(G.hash));
    assert(layer.isCanonical(A.hash));
    assert(layer.isCanonical(B.hash));
  });

  Deno.test(`[${mode}] basic conflict: higher weight wins`, () => {
    const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [100] };
    const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [80] };
    const { layer } = setup([G, A, B], canonicalOnly);

    layer.addConflict(A.hash, B.hash);
    layer.setVerifiedWeight(A.hash, [100]);
    layer.setVerifiedWeight(B.hash, [80]);

    assert(layer.isCanonical(A.hash));
    assertFalse(layer.isCanonical(B.hash));
  });

  Deno.test(`[${mode}] descendant of loser is non-canonical (Rule 1)`, () => {
    const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [100] };
    const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [50] };
    const C: TestBlock = { hash: h('C'), anchor: B.hash, aggregates: [], weight: [10] };
    const { layer } = setup([G, A, B, C], canonicalOnly);

    layer.addConflict(A.hash, B.hash);
    layer.setVerifiedWeight(A.hash, [100]);
    layer.setVerifiedWeight(B.hash, [50]);
    layer.setVerifiedWeight(C.hash, [10]);

    assert(layer.isCanonical(A.hash));
    assertFalse(layer.isCanonical(B.hash));
    assertFalse(layer.isCanonical(C.hash));
  });

  Deno.test(`[${mode}] aggregation rule: aggregator non-canonical when aggregate loses`, () => {
    const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [30] };
    const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [80] };
    const S: TestBlock = { hash: h('S'), anchor: G.hash, aggregates: [A.hash], weight: [50] };
    const { layer } = setup([G, A, B, S], canonicalOnly);

    layer.addConflict(A.hash, B.hash);
    layer.setVerifiedWeight(A.hash, [30]);
    layer.setVerifiedWeight(B.hash, [80]);
    layer.setVerifiedWeight(S.hash, [50]);

    assertFalse(layer.isCanonical(A.hash));
    assertFalse(layer.isCanonical(S.hash));
    assert(layer.isCanonical(B.hash));
  });

  Deno.test(`[${mode}] descendant weight flips conflict when winner's subtree is intact`, () => {
    // B's descendant D is canonical in both modes (no conflicts of its own),
    // so both modes agree.
    const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [90] };
    const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [80] };
    const D: TestBlock = { hash: h('D'), anchor: B.hash, aggregates: [], weight: [200] };
    const { layer } = setup([G, A, B, D], canonicalOnly);

    layer.addConflict(A.hash, B.hash);
    layer.setVerifiedWeight(A.hash, [90]);
    layer.setVerifiedWeight(B.hash, [80]);
    layer.setVerifiedWeight(D.hash, [200]);

    // B wins: 80 + 200 = 280 > 90
    assert(layer.isCanonical(B.hash));
    assertFalse(layer.isCanonical(A.hash));
    assert(layer.isCanonical(D.hash));
  });

  Deno.test(`[${mode}] tie-breaking by hash`, () => {
    const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [100] };
    const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [100] };
    const { layer } = setup([G, A, B], canonicalOnly);

    layer.addConflict(A.hash, B.hash);
    layer.setVerifiedWeight(A.hash, [100]);
    layer.setVerifiedWeight(B.hash, [100]);

    const aLower = Hash.compare(A.hash, B.hash) < 0;
    if (aLower) {
      assert(layer.isCanonical(A.hash));
      assertFalse(layer.isCanonical(B.hash));
    } else {
      assert(layer.isCanonical(B.hash));
      assertFalse(layer.isCanonical(A.hash));
    }
  });
}

// =====================================================================
// Tests where modes diverge
// =====================================================================

Deno.test('mode divergence: loser descendant weight excluded in canonical-only', () => {
  // Doc example: A(7) vs B(3), both anchor G. C(10) anchors B, D(12) anchors G.
  // C and D conflict. D wins (12 > 10), so C is non-canonical.
  //
  // All-descendants: B = 3 + 10 = 13 > A = 7. B wins.
  // Canonical-only:  B = 3 + 0 = 3  < A = 7. A wins.
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [7] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [3] };
  const C: TestBlock = { hash: h('C'), anchor: B.hash, aggregates: [], weight: [10] };
  const D: TestBlock = { hash: h('D'), anchor: G.hash, aggregates: [], weight: [12] };

  // All-descendants mode
  {
    const { layer } = setup([G, A, B, C, D], false);
    layer.addConflict(A.hash, B.hash);
    layer.addConflict(C.hash, D.hash);
    layer.setVerifiedWeight(A.hash, [7]);
    layer.setVerifiedWeight(B.hash, [3]);
    layer.setVerifiedWeight(C.hash, [10]);
    layer.setVerifiedWeight(D.hash, [12]);

    // B wins (13 > 7) even though C is non-canonical
    assert(layer.isCanonical(B.hash), 'all-desc: B should win');
    assertFalse(layer.isCanonical(A.hash), 'all-desc: A should lose');
    assertFalse(layer.isCanonical(C.hash), 'all-desc: C loses to D');
    assert(layer.isCanonical(D.hash), 'all-desc: D should win');
  }

  // Canonical-only mode
  {
    const { layer } = setup([G, A, B, C, D], true);
    layer.addConflict(A.hash, B.hash);
    layer.addConflict(C.hash, D.hash);
    layer.setVerifiedWeight(A.hash, [7]);
    layer.setVerifiedWeight(B.hash, [3]);
    layer.setVerifiedWeight(C.hash, [10]);
    layer.setVerifiedWeight(D.hash, [12]);

    // C loses to D -> B's canonical weight = 3. A = 7 wins.
    assert(layer.isCanonical(A.hash), 'canonical-only: A should win');
    assertFalse(layer.isCanonical(B.hash), 'canonical-only: B should lose');
    assertFalse(layer.isCanonical(C.hash), 'canonical-only: C loses to D');
    assert(layer.isCanonical(D.hash), 'canonical-only: D should win');
  }
});

Deno.test('canonical-only: convergence across two rounds', () => {
  // Round 1 (all-desc): B wins because of C's weight.
  // Round 2: C is non-canonical (lost to D) -> B loses to A.
  // Round 3: B non-canonical -> C doubly non-canonical. Stable.
  //
  // Verify the final state is stable by checking multiple queries.
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [7] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [3] };
  const C: TestBlock = { hash: h('C'), anchor: B.hash, aggregates: [], weight: [10] };
  const D: TestBlock = { hash: h('D'), anchor: G.hash, aggregates: [], weight: [12] };

  const { layer } = setup([G, A, B, C, D], true);
  layer.addConflict(A.hash, B.hash);
  layer.addConflict(C.hash, D.hash);
  layer.setVerifiedWeight(A.hash, [7]);
  layer.setVerifiedWeight(B.hash, [3]);
  layer.setVerifiedWeight(C.hash, [10]);
  layer.setVerifiedWeight(D.hash, [12]);

  // Verify stable result
  const view1 = layer.getCanonicalView();
  const view2 = layer.getCanonicalView();
  assertEquals(view1.size, view2.size);

  assert(layer.isCanonical(G.hash));
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(C.hash));
  assert(layer.isCanonical(D.hash));
  assertEquals(layer.getCanonicalView().size, 3); // G, A, D
});

Deno.test('canonical-only: no divergence when winner subtree is clean', () => {
  // B has descendant D with no conflicts. Both modes should agree.
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [50] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [30] };
  const D: TestBlock = { hash: h('D'), anchor: B.hash, aggregates: [], weight: [100] };
  const { layer } = setup([G, A, B, D], true);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [50]);
  layer.setVerifiedWeight(B.hash, [30]);
  layer.setVerifiedWeight(D.hash, [100]);

  // B wins: 30 + 100 = 130 > 50, and D is canonical (no conflicts)
  // Canonical-only doesn't change anything here.
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(D.hash));
});

Deno.test('canonical-only: cascading non-canonicality through aggregation', () => {
  // S aggregates C. C anchors B. B vs A conflict. C vs D conflict.
  // In canonical-only: C loses to D, B loses weight, A wins, B non-canonical,
  // C non-canonical (anchor rule), S non-canonical (aggregation rule).
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [7] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [3] };
  const C: TestBlock = { hash: h('C'), anchor: B.hash, aggregates: [], weight: [10] };
  const D: TestBlock = { hash: h('D'), anchor: G.hash, aggregates: [], weight: [12] };
  const S: TestBlock = { hash: h('S'), anchor: G.hash, aggregates: [C.hash], weight: [5] };

  const { layer } = setup([G, A, B, C, D, S], true);
  layer.addConflict(A.hash, B.hash);
  layer.addConflict(C.hash, D.hash);
  layer.setVerifiedWeight(A.hash, [7]);
  layer.setVerifiedWeight(B.hash, [3]);
  layer.setVerifiedWeight(C.hash, [10]);
  layer.setVerifiedWeight(D.hash, [12]);
  layer.setVerifiedWeight(S.hash, [5]);

  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(C.hash));
  assert(layer.isCanonical(D.hash));
  // S aggregates C which is non-canonical -> S non-canonical (Rule 2)
  assertFalse(layer.isCanonical(S.hash));
});

Deno.test('canonical-only: weight change triggers re-convergence', () => {
  // Start with D beating C, causing A to win in canonical-only mode.
  // Then increase C's weight so C beats D. Now B has canonical descendants -> B wins.
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [7] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [3] };
  const C: TestBlock = { hash: h('C'), anchor: B.hash, aggregates: [], weight: [10] };
  const D: TestBlock = { hash: h('D'), anchor: G.hash, aggregates: [], weight: [12] };

  const { layer } = setup([G, A, B, C, D], true);
  layer.addConflict(A.hash, B.hash);
  layer.addConflict(C.hash, D.hash);
  layer.setVerifiedWeight(A.hash, [7]);
  layer.setVerifiedWeight(B.hash, [3]);
  layer.setVerifiedWeight(C.hash, [10]);
  layer.setVerifiedWeight(D.hash, [12]);

  // Initial: C loses to D, so B = 3, A = 7 wins
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));

  // Now C's verified weight increases past D's
  layer.setVerifiedWeight(C.hash, [15]);

  // C now beats D (15 > 12). C is canonical -> B = 3 + 15 = 18 > A = 7. B wins.
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(C.hash));
  assertFalse(layer.isCanonical(D.hash));
});

Deno.test('canonical-only: deep chain with nested conflicts converges', () => {
  // G -> X -> Y -> Z, each with a competitor at the same level.
  // All competitors win their conflicts, making X, Y, Z non-canonical.
  // In canonical-only mode, X losing makes Y non-canonical (Rule 1),
  // which makes Z non-canonical.
  const X: TestBlock = { hash: h('X'), anchor: G.hash, aggregates: [], weight: [5] };
  const X2: TestBlock = { hash: h('X2'), anchor: G.hash, aggregates: [], weight: [10] };
  const Y: TestBlock = { hash: h('Y'), anchor: X.hash, aggregates: [], weight: [5] };
  const Y2: TestBlock = { hash: h('Y2'), anchor: G.hash, aggregates: [], weight: [3] };
  const Z: TestBlock = { hash: h('Z'), anchor: Y.hash, aggregates: [], weight: [5] };

  const { layer } = setup([G, X, X2, Y, Y2, Z], true);
  layer.addConflict(X.hash, X2.hash);
  layer.addConflict(Y.hash, Y2.hash);
  layer.setVerifiedWeight(X.hash, [5]);
  layer.setVerifiedWeight(X2.hash, [10]);
  layer.setVerifiedWeight(Y.hash, [5]);
  layer.setVerifiedWeight(Y2.hash, [3]);
  layer.setVerifiedWeight(Z.hash, [5]);

  // X2 wins (10 > 5+5+5=15? No -- effective weight includes all descendants)
  // all-desc: X = 5+5+5 = 15, X2 = 10. X wins in all-descendants.
  // In canonical-only, Y also wins its conflict (5 > 3), so Y is canonical,
  // Z is canonical. X = 5+5+5 = 15 > X2 = 10. Same result.
  assert(layer.isCanonical(X.hash));
  assertFalse(layer.isCanonical(X2.hash));
  assert(layer.isCanonical(Y.hash));
  assertFalse(layer.isCanonical(Y2.hash));
  assert(layer.isCanonical(Z.hash));
});

Deno.test('canonical-only: descendant losing strips weight from ancestor', () => {
  // A(1) vs B(1) conflict. C(100) anchors A, D(200) anchors G. C vs D conflict.
  // All-desc: A = 1+100 = 101, B = 1. A wins.
  // Canonical-only: C loses to D (100 < 200). A = 1+0 = 1, B = 1. Tie -> hash.
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [1] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [1] };
  const C: TestBlock = { hash: h('C'), anchor: A.hash, aggregates: [], weight: [100] };
  const D: TestBlock = { hash: h('D'), anchor: G.hash, aggregates: [], weight: [200] };

  // All-descendants: A wins
  {
    const { layer } = setup([G, A, B, C, D], false);
    layer.addConflict(A.hash, B.hash);
    layer.addConflict(C.hash, D.hash);
    layer.setVerifiedWeight(A.hash, [1]);
    layer.setVerifiedWeight(B.hash, [1]);
    layer.setVerifiedWeight(C.hash, [100]);
    layer.setVerifiedWeight(D.hash, [200]);

    // A = 1+100 = 101, B = 1. A wins.
    assert(layer.isCanonical(A.hash), 'all-desc: A should win');
    assertFalse(layer.isCanonical(B.hash), 'all-desc: B should lose');
  }

  // Canonical-only: A ties B, hash decides
  {
    const { layer } = setup([G, A, B, C, D], true);
    layer.addConflict(A.hash, B.hash);
    layer.addConflict(C.hash, D.hash);
    layer.setVerifiedWeight(A.hash, [1]);
    layer.setVerifiedWeight(B.hash, [1]);
    layer.setVerifiedWeight(C.hash, [100]);
    layer.setVerifiedWeight(D.hash, [200]);

    // C loses to D. A = 1, B = 1. Tie -> lower hash wins.
    assertFalse(layer.isCanonical(C.hash), 'canonical-only: C should lose to D');
    assert(layer.isCanonical(D.hash), 'canonical-only: D should win');

    const aLower = Hash.compare(A.hash, B.hash) < 0;
    if (aLower) {
      assert(layer.isCanonical(A.hash), 'canonical-only: A wins tie');
      assertFalse(layer.isCanonical(B.hash), 'canonical-only: B loses tie');
    } else {
      assert(layer.isCanonical(B.hash), 'canonical-only: B wins tie');
      assertFalse(layer.isCanonical(A.hash), 'canonical-only: A loses tie');
    }
  }
});

// =====================================================================
// Boost tests
// =====================================================================

Deno.test('boost flips conflict outcome', () => {
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [5] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [7] };
  const { layer } = setup([G, A, B], false);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [5]);
  layer.setVerifiedWeight(B.hash, [7]);

  // B wins without boost
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));

  // Boost A by 3 -> A's comparison weight = 8 > 7
  layer.setBoost(A.hash, 3);
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));
});

Deno.test('boost does NOT affect effective weight', () => {
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [5] };
  const { layer } = setup([G, A], false);

  layer.setVerifiedWeight(A.hash, [5]);
  layer.setBoost(A.hash, 100);

  // Effective weight should NOT include boost
  assertEquals(layer.getEffectiveWeight(A.hash), 5);
});

Deno.test('boost does NOT propagate to parent conflict', () => {
  // Parent P1 vs P2 conflict. Child C of P1 has a large boost.
  // The boost should NOT help P1 win.
  const P1: TestBlock = { hash: h('P1'), anchor: G.hash, aggregates: [], weight: [10] };
  const P2: TestBlock = { hash: h('P2'), anchor: G.hash, aggregates: [], weight: [12] };
  const C: TestBlock = { hash: h('C'), anchor: P1.hash, aggregates: [], weight: [1] };
  const { layer } = setup([G, P1, P2, C], false);

  layer.addConflict(P1.hash, P2.hash);
  layer.setVerifiedWeight(P1.hash, [10]);
  layer.setVerifiedWeight(P2.hash, [12]);
  layer.setVerifiedWeight(C.hash, [1]);
  layer.setBoost(C.hash, 1000);

  // P1 effective = 10 + 1 = 11, P2 = 12. Boost on C doesn't help P1.
  assertFalse(layer.isCanonical(P1.hash));
  assert(layer.isCanonical(P2.hash));
});

Deno.test('boost does NOT affect descendant weight', () => {
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [5] };
  const B: TestBlock = { hash: h('B'), anchor: A.hash, aggregates: [], weight: [10] };
  const { layer } = setup([G, A, B], false);

  layer.setVerifiedWeight(A.hash, [5]);
  layer.setVerifiedWeight(B.hash, [10]);
  layer.setBoost(B.hash, 1000);

  // Descendant weight of A should only be B's verified weight, not boost
  assertEquals(layer.getDescendantWeight(A.hash), 10);
});

Deno.test('boost works with canonical-only mode', () => {
  // Same divergence scenario, but boost on B compensates for lost descendant weight.
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [7] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [3] };
  const C: TestBlock = { hash: h('C'), anchor: B.hash, aggregates: [], weight: [10] };
  const D: TestBlock = { hash: h('D'), anchor: G.hash, aggregates: [], weight: [12] };

  const { layer } = setup([G, A, B, C, D], true);
  layer.addConflict(A.hash, B.hash);
  layer.addConflict(C.hash, D.hash);
  layer.setVerifiedWeight(A.hash, [7]);
  layer.setVerifiedWeight(B.hash, [3]);
  layer.setVerifiedWeight(C.hash, [10]);
  layer.setVerifiedWeight(D.hash, [12]);

  // Without boost: canonical-only makes A win (B=3 after C loses)
  assert(layer.isCanonical(A.hash));
  assertFalse(layer.isCanonical(B.hash));

  // Boost B by 5 -> B comparison weight = 3+5=8 > A=7. B wins.
  layer.setBoost(B.hash, 5);
  assert(layer.isCanonical(B.hash));
  assertFalse(layer.isCanonical(A.hash));
});

Deno.test('removeBlock cleans up boost', () => {
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [5] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [7] };
  const { layer } = setup([G, A, B], false);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [5]);
  layer.setVerifiedWeight(B.hash, [7]);
  layer.setBoost(A.hash, 10);

  // A wins with boost
  assert(layer.isCanonical(A.hash));

  // Remove A and re-add without boost
  layer.removeBlock(A.hash);
  layer.addBlock(A.hash);
  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [5]);

  // B should win now (boost was cleaned up)
  assertFalse(layer.isCanonical(A.hash));
  assert(layer.isCanonical(B.hash));
});

Deno.test('getConflictWinner reflects boost', () => {
  const A: TestBlock = { hash: h('A'), anchor: G.hash, aggregates: [], weight: [5] };
  const B: TestBlock = { hash: h('B'), anchor: G.hash, aggregates: [], weight: [7] };
  const { layer } = setup([G, A, B], false);

  layer.addConflict(A.hash, B.hash);
  layer.setVerifiedWeight(A.hash, [5]);
  layer.setVerifiedWeight(B.hash, [7]);

  assertEquals(layer.getConflictWinner(A.hash), B.hash);

  layer.setBoost(A.hash, 3);
  assertEquals(layer.getConflictWinner(A.hash), A.hash);
  assertEquals(layer.getConflictWinner(B.hash), A.hash);
});
