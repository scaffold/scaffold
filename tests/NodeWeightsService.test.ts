// End-to-end coverage for NodeWeightsService through real Block / BlockStore
// / DraftStore. The unit-level tests in NodeWeights.test.ts use a synthetic
// provider; this file pins the wiring: aggregation cache decoding, sampling
// factor application, draft-as-phantom-block, cache invalidation.

import { assertEquals } from '@std/assert';
import { withNodeFields } from './testutil/blockNodeFields.ts';

import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { PacketType } from '../src/core/Packet.ts';
import {
  AGGREGATION_CONTRACT,
  AtomSource,
  AtomType,
  Block,
  BlockStore,
} from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { encodeAggregationData } from '../src/contracts/AggregationContract.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { NodeWeightsService } from '../src/core/NodeWeightsService.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { PlacementService } from '../src/core/PlacementService.ts';
import { createDraft, Draft, DraftStore } from '../src/core/Draft.ts';

const h = (name: string): Hash => Hash.digest(name);

function aggMarker(chainWeights: number[]): Output {
  return {
    verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
    value: 0,
    body: encodeAggregationData({
      claimMask: [],
      newOutputCount: 0,
      aggregateOutputCounts: [],
      chainWeights,
      aggregateWeights: [],
    }),
  };
}

function makeBlock(opts: {
  name: string;
  anchor?: Hash;
  aggregates?: Hash[];
  declaredWeight?: number;
  /** When set, attaches an aggregation marker output carrying chainWeights. */
  chainWeights?: number[];
}): Block {
  const outputs: Output[] = opts.chainWeights ? [aggMarker(opts.chainWeights)] : [];
  return withNodeFields({
    hash: h(opts.name),
    anchor: opts.anchor ?? ZERO_HASH,
    aggregates: opts.aggregates ?? [],
    claimIndices: [],
    outputs,
    refs: [],
    declaredWeight: opts.declaredWeight ?? 0,
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
  });
}

function setup(...blocks: Block[]): {
  ctx: ProtocolContext;
  store: BlockStore;
  drafts: DraftStore;
  nw: NodeWeightsService;
} {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const drafts = ctx.get(DraftStore);
  const nw = ctx.get(NodeWeightsService);
  nw.setDraftStore(drafts);
  // Mirror NodeContext wiring: placement needs ConsensusService for the
  // canonical-aggregator query, and drafts derive their anchor through
  // placement. Register blocks in consensus so getCanonicalAggregator works.
  const consensus = ctx.get(ConsensusService);
  consensus.setDraftStore(drafts);
  const placement = ctx.get(PlacementService);
  consensus.setPlacement(placement);
  nw.setPlacement(placement);
  for (const b of blocks) {
    store.put(b);
    consensus.addBlock(b.hash);
  }
  return { ctx, store, drafts, nw };
}

// ---------------------------------------------------------------------------
// Diamond + Joel's competing-aggregator scenarios end-to-end
// ---------------------------------------------------------------------------

Deno.test('NodeWeightsService: diamond -- D aggregating {A, B} captures both', () => {
  // X anchor=genesis, A and B anchor to X, D aggregates {A, B} anchored to X.
  // D carries chainWeights=[30] in its aggregation marker (= A.self + B.self
  // attributed to X). Going via D:
  //   D.self = 3, X-descendants of D = {A (depth 1, self 10), B (depth 1, self 20)}
  //   per-Y wV[0..0] = empty, selfWeight totals 30.
  //   total via D = 3 + 30 = 33.
  // Going via A directly: derived(A) = [10] -> 10.
  // Going via B directly: derived(B) = [20] -> 20.
  // max = 33.
  const G = makeBlock({ name: 'G' });
  const X = makeBlock({ name: 'X', anchor: G.hash });
  const A = makeBlock({ name: 'A', anchor: X.hash, declaredWeight: 10 });
  const B = makeBlock({ name: 'B', anchor: X.hash, declaredWeight: 20 });
  const D = makeBlock({
    name: 'D',
    anchor: X.hash,
    aggregates: [A.hash, B.hash],
    declaredWeight: 3,
    chainWeights: [30],
  });
  const { nw } = setup(G, X, A, B, D);

  assertEquals(nw.descendantWeight(X.hash), 33);
});

Deno.test("NodeWeightsService: Joel's case 1 -- P doesn't aggregate B, A's branch wins at 150", () => {
  const G = makeBlock({ name: 'G' });
  const X = makeBlock({ name: 'X', anchor: G.hash });
  const A = makeBlock({ name: 'A', anchor: X.hash, declaredWeight: 100 });
  const B = makeBlock({ name: 'B', anchor: A.hash, declaredWeight: 50 });
  const P = makeBlock({
    name: 'P',
    anchor: G.hash,
    aggregates: [X.hash, A.hash],
    declaredWeight: 5,
  });
  const { nw } = setup(G, X, A, B, P);

  assertEquals(nw.descendantWeight(X.hash), 150);
});

Deno.test("NodeWeightsService: Joel's case 2 -- P aggregates B too, P's branch wins at 155", () => {
  const G = makeBlock({ name: 'G' });
  const X = makeBlock({ name: 'X', anchor: G.hash });
  const A = makeBlock({ name: 'A', anchor: X.hash, declaredWeight: 100 });
  const B = makeBlock({ name: 'B', anchor: A.hash, declaredWeight: 50 });
  const P = makeBlock({
    name: 'P',
    anchor: G.hash,
    aggregates: [X.hash, A.hash, B.hash],
    declaredWeight: 5,
  });
  const { nw } = setup(G, X, A, B, P);

  assertEquals(nw.descendantWeight(X.hash), 155);
});

// ---------------------------------------------------------------------------
// Drafts as phantom blocks
// ---------------------------------------------------------------------------

Deno.test('NodeWeightsService: drafts participate as phantom blocks anchored to real blocks', () => {
  // Real chain G <- A. A draft anchors (via pickAnchorForClaims) to A by
  // claiming A's outputs.
  const G = makeBlock({ name: 'G' });
  const A = makeBlock({ name: 'A', anchor: G.hash, declaredWeight: 10 });
  const { drafts, nw } = setup(G, A);

  // Build a draft that claims a real-block output of A so pickAnchorForClaims
  // resolves anchor=A. selfWeight via NodeWeightsService is
  // max(declaredWeight, effectiveWeight); we set declaredWeight=42.
  const draft: Draft = createDraft({
    declaredWeight: 42,
    claims: [{ producer: A.hash, outputIndex: 0 }],
    outputs: [],
    refs: [],
  });
  drafts.add(draft);

  // descendantWeight(A) should pick up the draft as an anchoring child.
  // derived(draft) = [42], candidate via draft = 42 + 0 = 42.
  // No other anchor children of A. No parents of A.
  // So descendantWeight(A) = 42.
  assertEquals(nw.descendantWeight(A.hash), 42);
});

Deno.test('NodeWeightsService: terminal drafts do not contribute', () => {
  // A solidified draft is excluded -- its solidified replacement is a real
  // Block in the store and would otherwise double-count.
  const G = makeBlock({ name: 'G' });
  const A = makeBlock({ name: 'A', anchor: G.hash, declaredWeight: 10 });
  const { drafts, nw } = setup(G, A);

  const draft: Draft = createDraft({
    declaredWeight: 42,
    claims: [{ producer: A.hash, outputIndex: 0 }],
    outputs: [],
    refs: [],
  });
  drafts.add(draft);
  // Move it through to solidified-equivalent terminal state: failure works
  // for this assertion since failed and solidified are both terminal.
  drafts.transition(draft.draftId, {
    phase: 'cancelled',
    reason: 'test',
  });

  assertEquals(nw.descendantWeight(A.hash), 0);
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

Deno.test('NodeWeightsService: cache invalidates on store mutation', () => {
  const G = makeBlock({ name: 'G' });
  const A = makeBlock({ name: 'A', anchor: G.hash, declaredWeight: 10 });
  const { store, nw } = setup(G, A);

  assertEquals(nw.descendantWeight(G.hash), 10);

  // Add another anchor child of G; it should beat A by max-over-children
  // (B.declaredWeight=50 > A.declaredWeight=10). Without invalidation we'd
  // still see 10.
  const B = makeBlock({ name: 'B', anchor: G.hash, declaredWeight: 50 });
  store.put(B);

  assertEquals(nw.descendantWeight(G.hash), 50);
});

Deno.test('NodeWeightsService: cache invalidates on draft transition', () => {
  const G = makeBlock({ name: 'G' });
  const A = makeBlock({ name: 'A', anchor: G.hash, declaredWeight: 10 });
  const { drafts, nw } = setup(G, A);

  const draft: Draft = createDraft({
    declaredWeight: 99,
    claims: [{ producer: A.hash, outputIndex: 0 }],
    outputs: [],
    refs: [],
  });
  drafts.add(draft);

  assertEquals(nw.descendantWeight(A.hash), 99);

  // Draft transitions to a terminal state -- it should drop out.
  drafts.transition(draft.draftId, {
    phase: 'cancelled',
    reason: 'test',
  });

  assertEquals(nw.descendantWeight(A.hash), 0);
});

// ---------------------------------------------------------------------------
// Sanity: derivedWeightVector composition with real aggregation cache
// ---------------------------------------------------------------------------

Deno.test('NodeWeightsService: derivedWeightVector reads chainWeights from aggregation cache', () => {
  // Aggregator P with declaredWeight 5 and chainWeights=[30, 7].
  // Provider sees: selfWeight(P) = 5 (declared), weightVector(P) = [30, 7]
  // (subtree contributions, factor=1 since no sampling wired).
  // No anchoring children. So derived(P) = own = [P.self=5, wV[0]=30, wV[1]=7]
  //                                       = [5, 30, 7].
  const G = makeBlock({ name: 'G' });
  const P = makeBlock({
    name: 'P',
    anchor: G.hash,
    declaredWeight: 5,
    chainWeights: [30, 7],
  });
  const { nw } = setup(G, P);

  assertEquals(nw.derivedWeightVector(P.hash), [5, 30, 7]);
});
