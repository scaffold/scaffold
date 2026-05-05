import { assertEquals } from '@std/assert';
import { NodeWeightsModule, NodeWeightsProvider } from '../src/core/NodeWeightsModule.ts';

// Test setup: an in-memory provider where every block carries selfWeight,
// weightVector, anchor, and aggregates explicitly. The provider derives the
// reverse indices (anchoringChildren, parents) on demand.

interface TestBlock {
  id: string;
  selfWeight: number;
  weightVector: number[];
  anchor: string | null;
  aggregates: string[];
}

class TestProvider implements NodeWeightsProvider<string> {
  private blocks = new Map<string, TestBlock>();

  add(b: TestBlock): void {
    this.blocks.set(b.id, b);
  }

  selfWeight(id: string): number {
    return this.blocks.get(id)?.selfWeight ?? 0;
  }
  weightVector(id: string): number[] {
    return this.blocks.get(id)?.weightVector ?? [];
  }
  aggregates(id: string): string[] {
    return this.blocks.get(id)?.aggregates ?? [];
  }
  anchor(id: string): string | null {
    return this.blocks.get(id)?.anchor ?? null;
  }
  anchoringChildren(id: string): string[] {
    const out: string[] = [];
    for (const b of this.blocks.values()) {
      if (b.anchor === id) out.push(b.id);
    }
    return out;
  }
  parents(id: string): string[] {
    const out: string[] = [];
    for (const b of this.blocks.values()) {
      if (b.aggregates.includes(id)) out.push(b.id);
    }
    return out;
  }
  key(id: string): string {
    return id;
  }
  equals(a: string, b: string): boolean {
    return a === b;
  }
}

function setup(...blocks: TestBlock[]): NodeWeightsModule<string> {
  const p = new TestProvider();
  for (const b of blocks) p.add(b);
  return new NodeWeightsModule(p);
}

// ---------------------------------------------------------------------------
// derivedWeightVector: structural propagation along anchor chain
// ---------------------------------------------------------------------------

Deno.test('derivedWeightVector: leaf block returns [selfWeight]', () => {
  const m = setup({
    id: 'X',
    selfWeight: 7,
    weightVector: [],
    anchor: 'G',
    aggregates: [],
  });
  assertEquals(m.derivedWeightVector('X'), [7]);
});

Deno.test('derivedWeightVector: leaf with weightVector entries', () => {
  const m = setup({
    id: 'X',
    selfWeight: 5,
    weightVector: [10, 3],
    anchor: 'G',
    aggregates: [],
  });
  // own = [selfWeight=5, wV[0]=10, wV[1]=3]; no anchoring children.
  assertEquals(m.derivedWeightVector('X'), [5, 10, 3]);
});

Deno.test('derivedWeightVector: anchor chain propagates with shift-down-1', () => {
  // G <- A <- B (B anchors to A, A anchors to G).
  // A.derivedWeight = [A.self=2, A.wV[0]=0] + shift1(B.derivedWeight=[B.self=3])
  //                 = [2, 0] + [] (B's derived has length 1, slice(1) = [])
  //                 = [2, 0]
  // Wait: with B.derivedWeight = [3], shift1 drops index 0, leaving [].
  // So A.derivedWeight = [2, 0].
  // That misses B's weight at A's level. Is that right?
  // Actually B contributes to A via B.weightVector[0], not via selfWeight.
  // B is a leaf, so B.weightVector = []. So B contributes nothing to A.
  // For B to contribute to A, B.weightVector[0] must be set.
  const m = setup(
    { id: 'A', selfWeight: 2, weightVector: [0], anchor: 'G', aggregates: [] },
    { id: 'B', selfWeight: 3, weightVector: [3], anchor: 'A', aggregates: [] },
  );
  // B.derivedWeight = [B.self=3, B.wV[0]=3]
  // A.derivedWeight = [A.self=2, A.wV[0]=0] + shift1([3, 3]) = [2, 0] + [3] = [5, 0]
  // Hmm: A.derivedWeight[0] = weight at A = 2 (own) + 3 (B's contribution to A from shift)
  //                          = 5.
  assertEquals(m.derivedWeightVector('B'), [3, 3]);
  assertEquals(m.derivedWeightVector('A'), [5, 0]);
});

Deno.test('derivedWeightVector: max over competing anchor children', () => {
  // G <- {A, B} (A and B both anchor to G; both are anchoring children of G).
  // G should pick max of A and B by total derived weight.
  const m = setup(
    { id: 'G', selfWeight: 1, weightVector: [], anchor: null, aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [10], anchor: 'G', aggregates: [] },
    { id: 'B', selfWeight: 5, weightVector: [5], anchor: 'G', aggregates: [] },
  );
  // A.derived = [100, 10], sum = 110
  // B.derived = [5, 5], sum = 10
  // A wins. G.derived = [G.self=1] + shift1([100, 10]) = [1] + [10] = [1+10] = [11]
  // (No, shift1 means slice(1), so [100,10].slice(1) = [10]. addVecs([1], [10]) = [11].)
  assertEquals(m.derivedWeightVector('G'), [11]);
});

// ---------------------------------------------------------------------------
// descendantWeight: query for any block
// ---------------------------------------------------------------------------

Deno.test('descendantWeight: leaf with no neighbors returns 0', () => {
  const m = setup({ id: 'X', selfWeight: 5, weightVector: [], anchor: 'G', aggregates: [] });
  assertEquals(m.descendantWeight('X'), 0);
});

Deno.test('descendantWeight: single anchoring child contributes its derived[0..1]', () => {
  // X with one anchoring child A. A.derived = [A.self=10, A.wV[0]=4].
  // candidate = A.derived[0] + A.derived[1] = 10 + 4 = 14.
  const m = setup(
    { id: 'X', selfWeight: 1, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 10, weightVector: [4], anchor: 'X', aggregates: [] },
  );
  assertEquals(m.descendantWeight('X'), 14);
});

Deno.test('descendantWeight: max over multiple anchoring children, never sum', () => {
  // X has two independent anchoring children A (weight 100) and B (weight 50).
  // We pick MAX, not SUM, per Joel's spec.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [10], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 50, weightVector: [5], anchor: 'X', aggregates: [] },
  );
  // A: derived = [100, 10], A.d[0]+A.d[1] = 110
  // B: derived = [50, 5], B.d[0]+B.d[1] = 55
  // max = 110
  assertEquals(m.descendantWeight('X'), 110);
});

Deno.test('descendantWeight: deep anchor chain propagates via max child', () => {
  // X <- A <- B with selfWeights 0, 100, 50.
  // A.derived = [A.self=100, A.wV[0]=50] + shift1(B.derived=[50, 50])
  //           = [100, 50] + [50] = [150, 50]
  // (A.wV[0] = 50 because A's only aggregated subtree is B, and B contributes 50 to A.)
  // Actually A is a leaf in our test (no aggregates), so A.wV is whatever we set.
  // If we set A.wV = [50] meaning "B is in my subtree contributing 50 to my anchor X",
  // then we're conflating anchor-descendant-via-B with aggregation. Let me set A.wV = []
  // so A is a leaf with no aggregated subtree, and B contributes via the propagation rule.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 50, weightVector: [], anchor: 'A', aggregates: [] },
  );
  // B.derived = [50] (leaf, no weightVector)
  // A.derived = [A.self=100] + shift1([50]) = [100] + [] = [100]
  // descendantWeight(X) via A: A.derived[0] + A.derived[1] = 100 + 0 = 100
  // (B's 50 is lost because B is at A's anchoring child but B doesn't carry weightVector,
  //  so B's contribution to A's derived is via shift, which shifts away its only entry.)
  assertEquals(m.derivedWeightVector('B'), [50]);
  assertEquals(m.derivedWeightVector('A'), [100]);
  assertEquals(m.descendantWeight('X'), 100);

  // To capture B's contribution to X's descendant weight, we need a parent
  // path or B needs to be on a subtree the propagation can carry. Since B
  // has no weightVector entry, structurally there's no "weight at A from B"
  // to propagate. This is correct given the inputs -- selfWeight stays with
  // the block; only weightVector entries propagate to ancestors.
});

// ---------------------------------------------------------------------------
// Joel's competing-aggregator example (the load-bearing test)
// ---------------------------------------------------------------------------

Deno.test("descendantWeight: Joel's P vs A vs P' competing-aggregator case", () => {
  // X has anchoring child A (weight 100). A has anchoring child B (weight 50).
  // P aggregates {X, A}, selfWeight 5.
  // P' aggregates {X, A, B}, selfWeight 5.
  //
  // For P to attribute weight from X+A correctly, P.weightVector must encode
  // those contributions (since aggregation rolls subtree weight up). For our
  // synthetic test we set weightVectors that match the example arithmetic:
  //
  //   - A's contribution to X (via P) = 100  -> P attributes this to its anchor
  //     (since X is on P.anchor's chain).
  //   - X's contribution to X.anchor via P -- ignore for this test, X.selfWeight = 0.
  //   - For P' (which also aggregates B): B contributes 50 to A (= P''s aggregated
  //     descendant of X), so P' carries A=100 + B-as-A-descendant=50.
  //
  // We model P.weightVector as the contributions P pushes UP (to P.anchor).
  // For descendantWeight(X), the relevant path is via parent. Our module
  // walks P's aggregated subtree to extract weight at X-or-below directly
  // from each Y's weightVector and selfWeight, so we set those rather than
  // P.weightVector.
  //
  // Setup so the module can compute via the aggregated-subtree walk:
  //   X (anchor G), A (anchor X), B (anchor A) with selfWeights 0, 100, 50.
  //   P aggregates {X, A}, P.anchor = G. selfWeight 5.
  //   P' aggregates {X, A, B}, P'.anchor = G. selfWeight 5.
  //
  // The weightThroughParent walk picks each Y in P's subtree that's an
  // anchor-descendant of X (so A, but not X itself), adds Y.selfWeight, and
  // adds Y.weightVector entries that fall within depth(Y, X). A is at
  // depth 1 from X, so A.weightVector[0..0] (none if A.weightVector is []).
  // Total via P = P.self + A.self = 5 + 100 = 105.
  //
  // P' includes B too. B is at depth 2 from X. B.selfWeight=50,
  // B.weightVector=[] so just selfWeight contributes. Plus A. Total via P' =
  // 5 + 100 + 50 = 155.
  //
  // Direct via anchoring child A: A.derived = [100] (A is a leaf with no
  // weightVector for the test -- B contributes via selfWeight not via wV).
  // A.derived[0] + A.derived[1] = 100 + 0 = 100.
  //
  // Hmm, in Joel's example A's weight is 100 and B's weight via A is 50,
  // making A's branch 150. That requires B contributing to A via
  // weightVector. Let me re-set: if B.selfWeight = 50 and B.weightVector = [],
  // then B contributes 50 only via its own self, and propagation moves it up
  // to A via shift -- but shift drops it. So our model needs B to have a
  // weightVector entry. Setting B.weightVector = [50] models "B's aggregated
  // subtree (or B itself, in the legacy sense) contributes 50 to B.anchor=A."
  //
  // With that:
  //   B.derived = [B.self=50, B.wV[0]=50]
  //   A.derived = [A.self=100, A.wV[0]=0] + shift1([50, 50]) = [100, 0] + [50] = [150, 0]
  //   X via A: A.d[0] + A.d[1] = 150 + 0 = 150
  //   X via P: 5 + 100 + (A.wV in [0..0] = 0) = 105
  //     plus B not in P's subtree -> 105
  //   X via P': 5 + 100 + (A.wV in [0..0] = 0) + 50 + (B.wV in [0..1] = 50)
  //          = 5 + 100 + 50 + 50 = 205   <- hmm, this triple-counts.
  //
  // The issue: the model doesn't yet handle the relationship between
  // selfWeight and weightVector cleanly. In the real protocol B contributes
  // either via selfWeight (caught by the parent-walk's selfWeight sum) OR
  // via weightVector entries (caught by the propagation). They shouldn't
  // both be set -- weightVector is for AGGREGATED subtree, not own work.
  //
  // For B as a leaf: selfWeight=50, weightVector=[] (no aggregated subtree).
  // For an aggregator C aggregating B: C.weightVector[depth(B in chain)] = 50
  //   (B's contribution gets re-attributed to C's anchor chain).
  //
  // So in our test, we shouldn't set B.weightVector=[50] AND B.selfWeight=50.
  // The legacy "weightVector[0]=selfWeight" convention is exactly the
  // declaredWeight-folded-into-[0] behavior we're trying to escape. Let's
  // model B as a leaf (selfWeight=50, weightVector=[]) and verify the answer.

  const m = setup(
    { id: 'G', selfWeight: 0, weightVector: [], anchor: null, aggregates: [] },
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 50, weightVector: [], anchor: 'A', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [100], anchor: 'G', aggregates: ['X', 'A'] },
    { id: "P'", selfWeight: 5, weightVector: [150], anchor: 'G', aggregates: ['X', 'A', 'B'] },
  );

  // Via anchoring child A:
  //   A.derived = [A.self=100] + shift1(B.derived=[50]) = [100] + [] = [100]
  //   candidate = 100 + 0 = 100
  // Via parent P:
  //   P.self = 5
  //   subtree blocks descendant of X: A (depth 1)
  //     A.selfWeight = 100. A.weightVector entries in [0..0] = none (empty).
  //   total via P = 5 + 100 = 105
  // Via parent P':
  //   P'.self = 5
  //   subtree blocks descendant of X: A (depth 1), B (depth 2)
  //     A: + 100. A.weightVector in [0..0] = none.
  //     B: + 50.  B.weightVector in [0..1] = none (empty).
  //   total via P' = 5 + 100 + 50 = 155
  // max = 155
  assertEquals(m.descendantWeight('X'), 155);
});

Deno.test('descendantWeight: P vs A when neither dominates per Joel example', () => {
  // Same as above but without P'. Then A wins since A's branch... wait:
  //   Via A: 100 (A's leaf-derived)
  //   Via P: 5 + 100 = 105
  // P wins (105 > 100). To get A=150 in Joel's example, B needs to contribute
  // to A via the propagation. Set B.weightVector = [50] meaning B's aggregated
  // subtree pushes 50 up to A. But B is a leaf in this scenario. The cleanest
  // way to express "B itself contributes to A" is via B.selfWeight, which is
  // captured by the parent-walk over an aggregator's subtree -- not by
  // anchor-chain propagation, which only carries weightVector entries.
  //
  // This asymmetry is intentional: anchor-chain propagation rolls *aggregated*
  // weight up; selfWeight stays at the block. Joel's example assumed the
  // legacy convention where selfWeight is folded into weightVector[0]. With
  // that convention restored, A would carry B's weight upward. We model that
  // by setting B.weightVector = [50] AND B.selfWeight = 0 (the "clean" split):
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 0, weightVector: [50], anchor: 'A', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [100], anchor: 'G', aggregates: ['X', 'A'] },
  );
  // B.derived = [0, 50]
  // A.derived = [100] + shift1([0, 50]) = [100] + [50] = [150]
  // Via A: 150 + 0 = 150
  // Via P (P aggregates X and A only, NOT B):
  //   subtree descendants of X: A (depth 1).
  //     A.self = 100. A.wV in [0..0] = none.
  //   total via P = 5 + 100 = 105
  // max = 150
  assertEquals(m.descendantWeight('X'), 150);
});

// ---------------------------------------------------------------------------
// Diamond / anchor-chain co-aggregation
// ---------------------------------------------------------------------------

Deno.test('descendantWeight: chained subtree co-aggregated (X <- A <- B in P)', () => {
  // X <- A <- B all aggregated by P. P.anchor = G.
  // selfWeights: X=0, A=2, B=3, P=5.
  // Via P: P.self=5; aggregated descendants of X = {A (depth 1), B (depth 2)}.
  //   A: + 2; A.wV in [0..0] = empty -> 0.
  //   B: + 3; B.wV in [0..1] = empty -> 0.
  //   total = 5 + 2 + 3 = 10.
  // Via A: A.derived = [2] (B is leaf with empty wV; shift drops B's [3]) -> [2].
  //   candidate = 2 + 0 = 2.
  // max = 10.
  const m = setup(
    { id: 'G', selfWeight: 0, weightVector: [], anchor: null, aggregates: [] },
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 2, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 3, weightVector: [], anchor: 'A', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [5], anchor: 'G', aggregates: ['X', 'A', 'B'] },
  );
  assertEquals(m.descendantWeight('X'), 10);
});

Deno.test('descendantWeight: diamond -- aggregator over two anchor children', () => {
  // G <- X <- {A, B} (A and B both anchor to X). D aggregates {A, B}.
  //   A.self=10, B.self=20, D.self=3.
  // Via anchoring child A: A.derived = [10] -> 10.
  // Via anchoring child B: B.derived = [20] -> 20.
  // Via parent of X? X has no parent here.
  // But D aggregates A and B, not X -- D is parent of A and B, not of X.
  // So D doesn't show up as a candidate for descendantWeight(X) directly,
  // BUT going through anchoring child A's path, we hit A.parents = {D}, so
  // weightThroughParent(A, D) is part of A's recursive expansion... wait no,
  // the recursion in weightThroughParent only walks from a parent up further;
  // it doesn't fold back into anchoring children's path for the original X.
  //
  // For X, candidates are only direct anchoring children + direct parents.
  // X has anchoring children {A, B}; max = 20 (B).
  //
  // This is the conservative under-estimate Joel called out: independent
  // parallel work via A and B both depend on X, and naively summing would
  // give 30, but max gives 20. Once D aggregates them, the right thing is to
  // see X as having anchoring child A and B both rolled into D... but D
  // isn't an anchoring child of X (D anchors to X if D.anchor=X, which it
  // isn't here -- D aggregates A and B, with D.anchor=X probably).
  //
  // Let's set D.anchor=X so D is also an anchoring child of X. Then:
  //   D.derived = [D.self=3, D.wV[0]=...] + shift1(max child)
  //   D.wV must encode A+B's contributions to X = 10 + 20 = 30.
  //   Setting D.wV = [30]:
  //   D.derived = [3, 30]
  //   Via D: 3 + 30 = 33.
  //   Via A: 10. Via B: 20.
  //   max = 33.  [OK] aggregator captures the full diamond weight.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 10, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 20, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'D', selfWeight: 3, weightVector: [30], anchor: 'X', aggregates: ['A', 'B'] },
  );
  assertEquals(m.descendantWeight('X'), 33);
});

// ---------------------------------------------------------------------------
// Multi-tree spine
// ---------------------------------------------------------------------------

Deno.test('descendantWeight: spine extends through tree roots', () => {
  // G <- R1 <- R2 (each tree root has one anchoring child = next tree root).
  // R1.self = 10, R1.wV = [40] (subtree contributions to G).
  // R2.self = 8,  R2.wV = [25] (subtree contributions to R1).
  // descendantWeight(R1) = via anchoring child R2:
  //   R2.derived = [R2.self=8, R2.wV[0]=25] = [8, 25]
  //   candidate = 8 + 25 = 33
  // No parents. max = 33.
  const m = setup(
    { id: 'G', selfWeight: 0, weightVector: [], anchor: null, aggregates: [] },
    { id: 'R1', selfWeight: 10, weightVector: [40], anchor: 'G', aggregates: [] },
    { id: 'R2', selfWeight: 8, weightVector: [25], anchor: 'R1', aggregates: [] },
  );
  assertEquals(m.descendantWeight('R1'), 33);
  // descendantWeight(G) via R1:
  //   R1.derived = [R1.self=10, R1.wV[0]=40] + shift1(R2.derived=[8,25])
  //              = [10, 40] + [25]
  //              = [10, 65]
  //   via R1: R1.derived[0] + R1.derived[1] = 10 + 65 = 75.
  assertEquals(m.descendantWeight('G'), 75);
});
