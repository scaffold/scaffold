import { assert, assertEquals, assertThrows } from '@std/assert';
import { ForestBase } from '../../src/logic/Forest.ts';
import { PlacementBase, PlacementRequest, PlacementResult } from '../../src/logic/Placement.ts';
import { AtomType, BLOCK_REF_TYPE } from '../../src/graph/types.ts';

// -- Graph fixtures ----------------------------------------------
//
// Placement reads three things off the graph: `anchor` (the anchor chain),
// `aggregatingNodes` (the aggregation chain) and the node's `type`, so the
// fakes carry only those plus a name to assert on.

interface FakeBlock {
  type: AtomType.Block;
  name: string;
  anchor?: FakeBlock | FakeRef;
  aggregatingNodes: FakeBlock[];
}

interface FakeRef {
  type: typeof BLOCK_REF_TYPE;
  name: string;
  aggregatingNodes: FakeBlock[];
}

type FakeNode = FakeBlock | FakeRef;

/** The new block anchors at `anchor` and aggregates each of `children`. */
const block = (
  name: string,
  anchor?: FakeBlock | FakeRef,
  ...children: FakeNode[]
): FakeBlock => {
  const self: FakeBlock = { type: AtomType.Block, name, anchor, aggregatingNodes: [] };
  for (const child of children) child.aggregatingNodes.push(self);
  return self;
};

const ref = (name: string): FakeRef => ({
  type: BLOCK_REF_TYPE,
  name,
  aggregatingNodes: [],
});

class TestPlacement extends PlacementBase<FakeNode> {
  private forest = new ForestBase();

  protected override anchorChain(node: FakeNode) {
    return this.forest.anchorChain<FakeBlock>(node);
  }

  protected override aggregators(node: FakeNode) {
    return this.forest.aggregators(node);
  }
}

type Req = Partial<Omit<PlacementRequest<FakeNode>, 'genesis'>>;

const place = (genesis: FakeBlock, request: Req = {}): PlacementResult<FakeNode> =>
  new TestPlacement().place({
    genesis,
    includes: request.includes ?? [],
    aggregates: request.aggregates ?? [],
    excludes: request.excludes ?? [],
  });

const chainOf = (result: PlacementResult<FakeNode>): string[] => {
  assert(result.ok, 'expected placement to succeed');
  return result.anchorChain.map((node) => node.name);
};

const anchorOf = (result: PlacementResult<FakeNode>): string => chainOf(result)[0];

const tipsOf = (result: PlacementResult<FakeNode>): string[] => {
  assert(!result.ok, 'expected placement to stall');
  return result.tips.map((tip) => tip.name).sort();
};

// -- Coverage ----------------------------------------------------

Deno.test('a claim on an unaggregated block anchors at that block', () => {
  const G = block('G');
  const A = block('A', G);
  assertEquals(anchorOf(place(G, { includes: [A] })), 'A');
});

Deno.test('the result is the anchor chain, anchor first, genesis last', () => {
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  assertEquals(chainOf(place(G, { includes: [C] })), ['C', 'B', 'A', 'G']);
});

Deno.test('claims jointly aggregated by Z anchor at Z', () => {
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  block('Z', G, X, Y);
  assertEquals(anchorOf(place(G, { includes: [X, Y] })), 'Z');
});

Deno.test('aggregation chains are followed transitively', () => {
  // X <- Z1 <- Z2, and Z2 also aggregates Y. Only Z2 reaches both claims.
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  const Z1 = block('Z1', G, X);
  block('Z2', G, Z1, Y);
  assertEquals(anchorOf(place(G, { includes: [X, Y] })), 'Z2');
});

Deno.test('among covering anchors the tightest wins -- selection is unspecified', () => {
  // Both P and the aggregation Z that swallowed it reach the claim on P, so
  // both are valid placements. PlacementBase has no selection rule yet (its
  // own TODO, and TODO.v2.md questions whether "tightest" is even right under
  // wp 4.2), so this pins today's pick rather than a decided behavior.
  const G = block('G');
  const P = block('P', G);
  block('Z', G, P);
  assertEquals(anchorOf(place(G, { includes: [P] })), 'P');
});

Deno.test('a candidate whose own chain is broken does not block a covering aggregator', () => {
  // X anchors a block we hold only by hash, so X cannot be qualified -- but the
  // aggregation that swallowed X reaches it and has an intact chain.
  const G = block('G');
  const X = block('X', ref('unknown'));
  block('Z', G, X);
  assertEquals(anchorOf(place(G, { includes: [X] })), 'Z');
});

Deno.test('a draft with nothing to cover anchors at genesis', () => {
  const G = block('G');
  assertEquals(chainOf(place(G)), ['G']);
});

// -- Stalls ------------------------------------------------------

Deno.test('claims in disjoint aggregation trees stall on both roots', () => {
  const G = block('G');
  const X = block('X', G);
  const Zx = block('Zx', G, X);
  const Y = block('Y', G);
  const Zy = block('Zy', G, Y);
  assertEquals(tipsOf(place(G, { includes: [X, Y] })), [Zx.name, Zy.name]);
});

Deno.test('claims on two unaggregated siblings stall -- no anchor reaches both', () => {
  // P1 and P2 both anchor R, so neither anchor chain contains the other. Only
  // an aggregation merging them helps (wp 4.2).
  const G = block('G');
  const R = block('R', G);
  const P1 = block('P1', R);
  const P2 = block('P2', R);
  assertEquals(tipsOf(place(G, { includes: [P1, P2] })), [P1.name, P2.name]);
});

Deno.test('an anchor chain we hold only by hash cannot be qualified', () => {
  const G = block('G');
  const P = block('P', ref('unknown'));
  assertEquals(tipsOf(place(G, { includes: [P] })), ['P']);
});

Deno.test('an aggregate anchored to a block we hold only by hash stalls on the ref', () => {
  // The returned tip is the ref itself, which no aggregation can resolve --
  // the caller has to fetch it.
  const G = block('G');
  const C = block('C', ref('missing'));
  assertEquals(tipsOf(place(G, { includes: [C], aggregates: [C] })), ['missing']);
});

Deno.test('tips repeat when several stalled claims share an aggregation root', () => {
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  block('Z', G, X, Y);
  const W = block('W', G);
  assertEquals(tipsOf(place(G, { includes: [X, Y, W] })), ['W', 'Z', 'Z']);
});

// -- Aggregating -------------------------------------------------

Deno.test('aggregating {C,D} along a chain anchors below both', () => {
  // G <- A <- B <- C <- D. Aggregating C and D puts them in our own tree; the
  // anchor has to be the first block outside it that still covers their
  // anchors -- B.
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  const D = block('D', C);
  assertEquals(anchorOf(place(G, { includes: [C, D], aggregates: [C, D] })), 'B');
});

Deno.test('aggregating only the tip anchors one step up', () => {
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  const D = block('D', C);
  assertEquals(anchorOf(place(G, { includes: [D], aggregates: [D] })), 'C');
});

Deno.test('a claim already inside our own tree does not constrain the anchor', () => {
  // We aggregate C, which aggregates X, and we also claim X. X is inside our
  // own tree, so only C's anchor constrains us.
  const G = block('G');
  const X = block('X', G);
  const C = block('C', G, X);
  assertEquals(anchorOf(place(G, { includes: [X, C], aggregates: [C] })), 'G');
});

Deno.test('an aggregate anchored inside our own tree imposes no coverage', () => {
  // We aggregate both B and C, and C anchors B. B is in our tree, so C's
  // anchor requirement is already satisfied; only B's anchor A constrains us.
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  assertEquals(anchorOf(place(G, { includes: [B, C], aggregates: [B, C] })), 'A');
});

Deno.test('claims and aggregates constrain the anchor together', () => {
  // G <- A <- B <- C. Claiming from A while aggregating C: A must be in reach
  // and C's anchor B must be outside our tree.
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  assertEquals(anchorOf(place(G, { includes: [A, C], aggregates: [C] })), 'B');
});

Deno.test('aggregating a block with no anchor is a caller bug', () => {
  const G = block('G');
  assertThrows(() => place(G, { aggregates: [G] }), Error, 'Broken anchor');
});

// -- Excludes ----------------------------------------------------

Deno.test('a rival claimant on our lineage forces a stall', () => {
  // G <- Y <- X. Every anchor reaching X also reaches Y, which already claims
  // the output we want, so there is no placement where our claim wins.
  const G = block('G');
  const Y = block('Y', G);
  const X = block('X', Y);
  assertEquals(tipsOf(place(G, { includes: [X], excludes: [Y] })), ['X']);
});

Deno.test('a rival claimant on another branch is out of reach', () => {
  const G = block('G');
  const Y = block('Y', G);
  const X = block('X', G);
  assertEquals(anchorOf(place(G, { includes: [X], excludes: [Y] })), 'X');
});

Deno.test('a rival is in reach through its aggregators', () => {
  // Z aggregates our producer X and the rival Y, so anchoring at Z would pull
  // Y into reach. Anchoring at X keeps it out.
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  block('Z', G, X, Y);
  assertEquals(anchorOf(place(G, { includes: [X], excludes: [Y] })), 'X');
});

Deno.test('BUG: a rival inside our own tree does not stop placement', () => {
  // Expected: a refusal. Actual: ok, anchored at X. We aggregate Z, whose tree
  // holds the rival Y. wp 4.4 walks aggregates before self, so Y orders ahead
  // of us and our claim is the disqualified one (wp 5.3) -- in a block that is
  // itself the aggregation carrying the double-spend. No anchor avoids it, yet
  // place only tests rivals against the anchor's reach. Basis for expecting
  // place to own this: it already refuses the mirror case (a rival unavoidably
  // in reach), and BlockBuilderModule2.rivalClaimants passes every rival it
  // finds regardless of position.
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  const Z = block('Z', G, Y);
  assertThrows(
    () => place(G, { includes: [X, Z], aggregates: [Z], excludes: [Y] }),
    Error,
    'excluded block',
  );
});
