import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  PlacementModule,
  PlacementNode,
  PlacementRequest,
  PlacementResult,
} from '../src/core/PlacementModule2.ts';
import { AtomSource, AtomType, Block, BLOCK_REF_TYPE, BlockRef } from '../src/core/types.ts';

// -- Graph fixtures ----------------------------------------------
//
// Placement reads three things off the graph: `hash`, `anchor` (the anchor
// chain) and `aggregatingNodes` (the aggregation chain). The rest of `Block`
// is filled in so the fixtures type-check.

function block(name: string, anchor?: Block | BlockRef): Block {
  return {
    hash: Hash.digest(name),
    type: AtomType.Block,
    source: AtomSource.Local,
    receivedAt: 0,
    raw: new Uint8Array(),
    message: new Uint8Array(),
    fromConnections: [],
    toConnections: new Set(),
    payload: {
      anchor: anchor?.hash ?? Hash.digest('genesis'),
      chain: [],
      aggregates: [],
      claims: [],
      refs: [],
      outputs: [],
      timestampMs: 0,
    },
    anchor,
    aggregates: [],
    claims: [],
    anchoringNodes: [],
    aggregatingNodes: [],
    resolvingOutputs: new Map(),
    listeners: new Set(),
  };
}

function ref(name: string): BlockRef {
  return {
    hash: Hash.digest(name),
    type: BLOCK_REF_TYPE,
    connections: [],
    anchoringNodes: [],
    aggregatingNodes: [],
    resolvingOutputs: new Map(),
    listeners: new Set(),
  };
}

/** `parent` aggregates each child, canonically. */
function aggregates(parent: Block, ...children: PlacementNode[]): Block {
  for (const child of children) {
    parent.aggregates.push({ block: child, outputCount: 0n });
    child.aggregatingNodes.push(parent);
  }
  return parent;
}

class TestPlacement extends PlacementModule {
  protected override getCanonicalAggregator(node: PlacementNode): Block | undefined {
    return node.aggregatingNodes[0];
  }
  protected override logger() {
    return undefined;
  }
}

const place = (request: Partial<PlacementRequest>): PlacementResult =>
  new TestPlacement().place({
    includes: request.includes ?? [],
    aggregates: request.aggregates ?? [],
    excludes: request.excludes ?? [],
  });

const anchorOf = (result: PlacementResult): string => {
  assert(result.ok, 'expected placement to succeed');
  return result.anchor.hash.toHex();
};

const tipsOf = (result: PlacementResult): string[] => {
  assert(!result.ok, 'expected placement to stall');
  return result.tips.map((tip) => tip.hash.toHex()).sort();
};

const hexes = (...nodes: PlacementNode[]): string[] => nodes.map((n) => n.hash.toHex()).sort();

// -- Coverage ----------------------------------------------------

Deno.test('a claim on an unaggregated block anchors at that block', () => {
  const G = block('G');
  const A = block('A', G);
  assertEquals(anchorOf(place({ includes: [A] })), A.hash.toHex());
});

Deno.test('claims jointly aggregated by Z anchor at Z', () => {
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  aggregates(block('Z', G), X, Y);
  assertEquals(anchorOf(place({ includes: [X, Y] })), Hash.digest('Z').toHex());
});

Deno.test('aggregation chains are followed transitively', () => {
  // X <- Z1 <- Z2, and Z2 also aggregates Y. Only Z2 reaches both claims.
  const G = block('G');
  const X = block('X', G);
  const Y = block('Y', G);
  const Z1 = aggregates(block('Z1', G), X);
  const Z2 = aggregates(block('Z2', G), Z1, Y);
  assertEquals(anchorOf(place({ includes: [X, Y] })), Z2.hash.toHex());
});

Deno.test('among covering anchors the tightest wins', () => {
  // Both P and the aggregation Z that swallowed it reach the claim on P.
  const G = block('G');
  const P = block('P', G);
  aggregates(block('Z', G), P);
  assertEquals(anchorOf(place({ includes: [P] })), P.hash.toHex());
});

// -- Stalls ------------------------------------------------------

Deno.test('claims in disjoint aggregation trees stall on both roots', () => {
  const G = block('G');
  const X = block('X', G);
  const Zx = aggregates(block('Zx', G), X);
  const Y = block('Y', G);
  const Zy = aggregates(block('Zy', G), Y);
  assertEquals(tipsOf(place({ includes: [X, Y] })), hexes(Zx, Zy));
});

Deno.test('claims on two unaggregated siblings stall -- no anchor reaches both', () => {
  // The v2 case with no v1 analogue: P1 and P2 both anchor R, so neither
  // anchor chain contains the other. Only an aggregation merging them helps.
  const G = block('G');
  const R = block('R', G);
  const P1 = block('P1', R);
  const P2 = block('P2', R);
  assertEquals(tipsOf(place({ includes: [P1, P2] })), hexes(P1, P2));
});

Deno.test('an anchor chain we hold only by hash cannot be qualified', () => {
  const P = block('P', ref('unknown'));
  assertEquals(tipsOf(place({ includes: [P] })), hexes(P));
});

Deno.test('a draft with nothing to cover is a caller bug', () => {
  assertThrows(() => place({}), Error);
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
  assertEquals(anchorOf(place({ includes: [C, D], aggregates: [C, D] })), B.hash.toHex());
});

Deno.test('aggregating only the tip anchors one step up', () => {
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  const D = block('D', C);
  assertEquals(anchorOf(place({ includes: [D], aggregates: [D] })), C.hash.toHex());
});

Deno.test('a claim already inside our own tree does not constrain the anchor', () => {
  // We aggregate C, which canonically aggregates X, and we also claim X.
  // X is covered by "included in B", so only C's anchor constrains us.
  const G = block('G');
  const X = block('X', G);
  const C = aggregates(block('C', G), X);
  assertEquals(anchorOf(place({ includes: [X, C], aggregates: [C] })), G.hash.toHex());
});

Deno.test('claims and aggregates constrain the anchor together', () => {
  // G <- A <- B <- C. Claiming from A while aggregating C: A must be in reach
  // (rules out C's own subtree) and C's anchor B must be outside our tree.
  const G = block('G');
  const A = block('A', G);
  const B = block('B', A);
  const C = block('C', B);
  assertEquals(anchorOf(place({ includes: [A, C], aggregates: [C] })), B.hash.toHex());
});

// -- Excludes ----------------------------------------------------

Deno.test('a rival claimant on our lineage forces a stall', () => {
  // G <- Y <- X. Every anchor reaching X also reaches Y, which already claims
  // the output we want -- so there is no placement where our claim wins.
  const G = block('G');
  const Y = block('Y', G);
  const X = block('X', Y);
  assertEquals(tipsOf(place({ includes: [X], excludes: [Y] })), hexes(X));
});

Deno.test('a rival claimant on another branch is out of reach', () => {
  const G = block('G');
  const Y = block('Y', G);
  const X = block('X', G);
  assertEquals(anchorOf(place({ includes: [X], excludes: [Y] })), X.hash.toHex());
});
