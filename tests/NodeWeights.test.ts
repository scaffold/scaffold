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

Deno.test('derivedWeightVector: anchor chain propagates with shift-down-1 plus deeper accumulation', () => {
  // G <- A <- B (B anchors to A, A anchors to G).
  const m = setup(
    { id: 'A', selfWeight: 2, weightVector: [0], anchor: 'G', aggregates: [] },
    { id: 'B', selfWeight: 3, weightVector: [3], anchor: 'A', aggregates: [] },
  );
  // B.derived = [B.self=3, B.wV[0]=3]
  // A.derived[0] = A.self=2 + B.derived[1]=3 + B.derived[0]=3 = 8 (B is in A's deeper chain)
  // A.derived[1] = A.wV[0]=0 + B.derived[2]=0 = 0
  assertEquals(m.derivedWeightVector('B'), [3, 3]);
  assertEquals(m.derivedWeightVector('A'), [8, 0]);
});

Deno.test('derivedWeightVector: max over competing anchor children', () => {
  // G <- {A, B} (A and B both anchor to G; both are anchoring children of G).
  // G should pick max of A and B by total derived weight.
  const m = setup(
    { id: 'G', selfWeight: 1, weightVector: [], anchor: null, aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [10], anchor: 'G', aggregates: [] },
    { id: 'B', selfWeight: 5, weightVector: [5], anchor: 'G', aggregates: [] },
  );
  // A.derived = [100, 10], sum = 110 (A wins over B's 10).
  // G.derived[0] = G.self=1 + A.derived[1]=10 + A.derived[0]=100 = 111.
  assertEquals(m.derivedWeightVector('G'), [111]);
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

Deno.test('descendantWeight: deep anchor chain accumulates deeper selfWeights', () => {
  // X <- A <- B with selfWeights 0, 100, 50; all leaves (empty weightVector).
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 50, weightVector: [], anchor: 'A', aggregates: [] },
  );
  // B.derived = [50]
  // A.derived[0] = A.self=100 + B.derived[1]=0 + B.derived[0]=50 = 150
  // descendantWeight(X) via A = A.derived[0]+A.derived[1] = 150 + 0 = 150
  assertEquals(m.derivedWeightVector('B'), [50]);
  assertEquals(m.derivedWeightVector('A'), [150]);
  assertEquals(m.descendantWeight('X'), 150);
});

// ---------------------------------------------------------------------------
// Joel's competing-aggregator example (the load-bearing test)
// ---------------------------------------------------------------------------

Deno.test("descendantWeight: Joel's anchoring vs aggregator case 1", () => {
  // P doesn't aggregate B so it's not chosen as the descendant of X
  const m = setup(
    { id: 'G', selfWeight: 0, weightVector: [], anchor: null, aggregates: [] },
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 50, weightVector: [], anchor: 'A', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [], anchor: 'G', aggregates: ['X', 'A'] },
  );

  assertEquals(m.descendantWeight('X'), 150);
});

Deno.test("descendantWeight: Joel's anchoring vs aggregator case 2", () => {
  // P aggregates B so it's chosen as the descendant of X
  const m = setup(
    { id: 'G', selfWeight: 0, weightVector: [], anchor: null, aggregates: [] },
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 50, weightVector: [], anchor: 'A', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [], anchor: 'G', aggregates: ['X', 'A', 'B'] },
  );

  assertEquals(m.descendantWeight('X'), 155);
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
  //   R1.derived[0] = R1.self=10 + R2.derived[1]=25 + R2.derived[0]=8 = 43
  //   R1.derived[1] = R1.wV[0]=40 + R2.derived[2]=0 = 40
  //   via R1 = 43 + 40 = 83
  assertEquals(m.descendantWeight('G'), 83);
});

// ---------------------------------------------------------------------------
// Coverage gaps from the followup audit
// ---------------------------------------------------------------------------

Deno.test("descendantWeight: parent path picks up parent's own anchor child via descendantWeight(P)", () => {
  // X has no anchor children; only a parent P, which itself has anchor child Q.
  // Confirms the "extension via descendantWeight(P)" path actually pulls Q in.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [], anchor: 'G', aggregates: ['X'] },
    { id: 'Q', selfWeight: 100, weightVector: [], anchor: 'P', aggregates: [] },
  );
  // No anchor children of X. Via parent P:
  //   P.self=5; aggregates [X]: depth 0, skip.
  //   + descendantWeight(P): via Q -> derived(Q)=[100], 100+0 = 100.
  //   = 5 + 100 = 105.
  assertEquals(m.descendantWeight('X'), 105);
});

Deno.test('descendantWeight: aggregator chain depth >= 2 (PP aggregates P aggregates X)', () => {
  // X.anchor=G; P.anchor=G aggregates X; PP.anchor=G aggregates P. P sits in
  // PP's aggregated subtree but is NOT an anchor-descendant of X (P.anchor=G,
  // not X), so the PP-direct path doesn't see P. The via-P path adds P.self
  // and recurses into descendantWeight(P) -> weightThroughParent(P, PP).
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'P', selfWeight: 20, weightVector: [], anchor: 'G', aggregates: ['X'] },
    { id: 'PP', selfWeight: 30, weightVector: [], anchor: 'G', aggregates: ['P'] },
  );
  // Via P: P.self=20 + (X depth 0 skip) + descendantWeight(P)
  //   descendantWeight(P): via parent PP:
  //     PP.self=30 + (P depth-from-P-to-P=0, skip) + descendantWeight(PP)=0 = 30.
  //   So descendantWeight(P) = 30.
  // Via P total = 20 + 30 = 50.
  // Via PP directly: PP.self=30 + (P not anchor descendant of X, skip) + 0 = 30.
  // max = 50.
  assertEquals(m.descendantWeight('X'), 50);
});

Deno.test('descendantWeight: anchor-child branch wins over parent branch', () => {
  // Heavy anchor-child A vs lightweight parent P.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 200, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'P', selfWeight: 10, weightVector: [], anchor: 'G', aggregates: ['X'] },
  );
  // Via A: derived(A)=[200], 200 + 0 = 200.
  // Via P: 10 + 0 (X skip) + descendantWeight(P)=0 = 10.
  // max = 200.
  assertEquals(m.descendantWeight('X'), 200);
});

Deno.test('descendantWeight: parent branch wins over anchor-child branch', () => {
  // Lightweight anchor-child A vs heavy parent P that aggregates X+A.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 10, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'P', selfWeight: 100, weightVector: [], anchor: 'G', aggregates: ['X', 'A'] },
  );
  // Via A: derived(A)=[10] = 10.
  // Via P: 100 + (X skip) + (A depth 1: A.wV[0..0]=none + A.self=10) + descendantWeight(P)=0
  //      = 100 + 10 = 110.
  // max = 110.
  assertEquals(m.descendantWeight('X'), 110);
});

Deno.test('descendantWeight: max across multiple competing parents (no superset)', () => {
  // Two parents covering disjoint anchor-descendants of X.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 50, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'B', selfWeight: 40, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'P', selfWeight: 10, weightVector: [], anchor: 'G', aggregates: ['X', 'A'] },
    { id: "P'", selfWeight: 10, weightVector: [], anchor: 'G', aggregates: ['X', 'B'] },
  );
  // Via A: derived(A)=[50] = 50.
  // Via B: derived(B)=[40] = 40.
  // Via P: 10 + (A: 50) + 0 = 60.
  // Via P': 10 + (B: 40) + 0 = 50.
  // max = 60.
  assertEquals(m.descendantWeight('X'), 60);
});

Deno.test('descendantWeight: diamond overlap -- max across parent+anchor-child, never sum', () => {
  // X has anchor child A AND parent P that aggregates {X, A}. Both branches
  // include A. If we summed them, A would be counted twice.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 100, weightVector: [], anchor: 'X', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [], anchor: 'G', aggregates: ['X', 'A'] },
  );
  // Via A: derived(A)=[100] = 100.
  // Via P: 5 + (A: 100) + 0 = 105.
  // max = 105 (NOT 100 + 105 = 205).
  assertEquals(m.descendantWeight('X'), 105);
});

Deno.test('descendantWeight: solo block with no neighbours returns 0 cleanly', () => {
  // Genesis-shaped: no anchor, no parents, no anchor children.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: null, aggregates: [] },
  );
  assertEquals(m.descendantWeight('X'), 0);
  assertEquals(m.derivedWeightVector('X'), [0]);
});

Deno.test('weightThroughParent: weightVector entries past depth-to-X are not counted', () => {
  // A is anchor-descendant of X at depth 1. A.weightVector has entries past
  // index 0; those land on X.anchor and above, which do NOT depend on X.
  const m = setup(
    { id: 'X', selfWeight: 0, weightVector: [], anchor: 'G', aggregates: [] },
    { id: 'A', selfWeight: 10, weightVector: [100, 200, 300], anchor: 'X', aggregates: [] },
    { id: 'P', selfWeight: 5, weightVector: [], anchor: 'G', aggregates: ['X', 'A'] },
  );
  // Via P: 5 + (X skip) + (A depth 1: wV[0..0] = 100 only; +selfWeight=10) + 0
  //      = 5 + 100 + 10 = 115.
  // (A.wV[1]=200 and A.wV[2]=300 must be excluded -- they belong to X's ancestors.)
  // Via A: derived(A) = [10, 100, 200, 300]; descendantWeight via A = 10 + 100 = 110.
  // max = 115.
  assertEquals(m.descendantWeight('X'), 115);
});
