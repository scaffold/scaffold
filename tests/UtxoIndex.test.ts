// Regression tests for UtxoIndex claim resolution.
//
// Earlier, UtxoIndex.removeBlockClaimedOutputs hand-rolled a walk over
// the anchor's "extended" output array (via the now-removed
// `collectExtendedOutputs`) and indexed it by `claimIdx - ownOutputCount`.
// That walk silently lost the anchor's own self-claims and couldn't see
// aggregate subtree outputs at all, so descendant claims that should
// have resolved to a specific aggregate's marker (or to a survivor of
// an anchor's self-claim) instead removed unrelated UTXOs from the
// index. The chess demo surfaced this twice: once when a join block's
// signature claim landed on the create-game's RECORD/"game" self-claim
// slot, and again when an aggregation block's claims of aggregate AGG
// markers got reinterpreted as anchor.output_space slots and removed
// the creator's signature change output.
//
// These tests pin the post-fix behavior: UtxoIndex resolves every
// external claim through OutputSpaceModule, so self-claims and
// aggregate subtree outputs are handled uniformly.

import { assert, assertEquals } from '@std/assert';
import { withNodeFields } from './testutil/blockNodeFields.ts';

import { PacketType } from '../src/core/Packet.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output } from '../src/core/BlockCreationModule.ts';
import {
  AGGREGATION_CONTRACT,
  AtomSource,
  AtomType,
  Block,
  BlockStore,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../src/core/Block.ts';
import {
  encodeAggregationData,
  makeAggregationOutput,
} from '../src/contracts/AggregationContract.ts';
import { UtxoIndex, verifierKey } from '../src/node/UtxoIndex.ts';

// -- Test helpers ---------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeBlock(opts: {
  name: string;
  anchor?: Hash;
  outputs?: Output[];
  claimIndices?: number[];
  aggregates?: Hash[];
}): Block {
  const claimIndices = (opts.claimIndices ?? []).slice().sort((a, b) => a - b);
  return withNodeFields({
    hash: h(opts.name),
    anchor: opts.anchor ?? ZERO_HASH,
    outputs: opts.outputs ?? [],
    claimIndices,
    refs: [],
    aggregates: opts.aggregates ?? [],
    declaredWeight: 1,
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

function sigOut(label: string, value: number): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: enc(label) },
    value,
    body: new Uint8Array(0),
  };
}

function recordOut(key: string): Output {
  return {
    verifier: { contract: RECORD_CONTRACT, params: enc(key) },
    value: 0,
    body: enc(`record-data-${key}`),
  };
}

function isUnspent(idx: UtxoIndex, block: Block, outputIndex: number): boolean {
  return idx.isUnspent(block.hash, outputIndex);
}

// -- Tests ----------------------------------------------------------

Deno.test('UtxoIndex: anchor self-claims do not shift descendant claim resolution', () => {
  // Genesis ──> A ──> B
  //
  // Genesis: [SIG→g0, SIG→g1, SIG→g2]
  // A:       [SIG→a0, RECORD/"meta", SIG→a1]
  //          claims = [1, 3]   // self-claim RECORD (idx 1) + claim genesis idx 0
  // B's anchor is A. B claims ext_idx 1 of (own ++ output_space(A)). The
  // pre-fix walk computed [a0, RECORD, a1, g1, g2] (RECORD still in,
  // genesis idx 0 dropped) and resolved B's claim to RECORD. The
  // post-fix walk uses output_space(A) = [a0, a1, g1, g2] and resolves
  // to a1 (the second of A's own outputs). This test pins that.

  const store = new BlockStore();
  const idx = new UtxoIndex(store);

  const genesis = makeBlock({
    name: 'genesis',
    outputs: [sigOut('g0', 100), sigOut('g1', 200), sigOut('g2', 300)],
  });

  const a = makeBlock({
    name: 'A',
    anchor: genesis.hash,
    outputs: [sigOut('a0', 50), recordOut('meta'), sigOut('a1', 999)],
    // Self-claim RECORD at idx 1; external-claim genesis idx 0
    // (own_count=3, so claim 3 → ext idx 0).
    claimIndices: [1, 3],
  });

  // A.claims must balance throughput in real life, but UtxoIndex doesn't
  // care -- we test claim-resolution only.

  store.put(genesis);
  store.put(a);
  idx.blockBecameCanonical(genesis);
  idx.blockBecameCanonical(a);

  // After A is canonical: genesis idx 0 (g0) is spent; g1 and g2 remain.
  assertEquals(isUnspent(idx, genesis, 0), false);
  assertEquals(isUnspent(idx, genesis, 1), true);
  assertEquals(isUnspent(idx, genesis, 2), true);
  // A's own outputs: a0 and a1 are spendable (RECORD is self-claimed
  // but UtxoIndex still indexes it; the verifier-key namespace
  // separation is what matters in practice).
  assertEquals(isUnspent(idx, a, 0), true);
  assertEquals(isUnspent(idx, a, 2), true);

  // B claims ext_idx 1 of its anchor A. output_space(A) = [a0, a1, g1, g2]
  // (drop RECORD via self-claim at extended-vector position 1; drop g0
  // via external claim at position 3). So output_space(A)[1] = a1.
  //
  // B's claim index = own_count(B) + 1. B has no own outputs in this
  // fixture, so claim = 1.
  const b = makeBlock({
    name: 'B',
    anchor: a.hash,
    outputs: [],
    claimIndices: [1],
  });
  store.put(b);
  idx.blockBecameCanonical(b);

  // Post-fix: a1 is now spent (B claimed it).
  assertEquals(isUnspent(idx, a, 2), false, 'B should have spent a1, not RECORD or g1');
  // a0, g1, g2 are still untouched.
  assertEquals(isUnspent(idx, a, 0), true, 'a0 must still be unspent');
  assertEquals(isUnspent(idx, genesis, 1), true, 'g1 must still be unspent');
  assertEquals(isUnspent(idx, genesis, 2), true, 'g2 must still be unspent');
});

Deno.test('UtxoIndex: aggregation block claims index into agg.new outputs, not anchor.output_space', () => {
  // Genesis ──> Anchor (with AGG marker + SIG output)
  //   Anchor's children L1, L2, L3 each carry an AGG marker.
  //   AggBlock anchors at Anchor and aggregates [L1, L2, L3].
  //   AggBlock's claims should consume: 3 of the leaves' AGG markers
  //   plus 1 from Anchor's own output_space (the AGG marker).
  //
  // Pre-fix UtxoIndex would route AggBlock's claims into anchor's
  // output_space and remove unrelated SIG outputs there. Post-fix it
  // should remove exactly the four AGG markers and nothing else.

  const store = new BlockStore();
  const idx = new UtxoIndex(store);

  const genesis = makeBlock({
    name: 'genesis',
    outputs: [sigOut('g', 1_000_000)],
  });

  // Anchor block: AGG marker + a SIG output that we DON'T want spent.
  const anchor = makeBlock({
    name: 'anchor',
    anchor: genesis.hash,
    outputs: [makeAggregationOutput(), sigOut('keep-me', 500)],
  });

  // Three leaves, each a child of anchor with its own AGG marker.
  const l1 = makeBlock({
    name: 'L1',
    anchor: anchor.hash,
    outputs: [makeAggregationOutput(), sigOut('l1-keep', 1)],
  });
  const l2 = makeBlock({
    name: 'L2',
    anchor: anchor.hash,
    outputs: [makeAggregationOutput(), sigOut('l2-keep', 2)],
  });
  const l3 = makeBlock({
    name: 'L3',
    anchor: anchor.hash,
    outputs: [makeAggregationOutput(), sigOut('l3-keep', 3)],
  });

  store.put(genesis);
  store.put(anchor);
  store.put(l1);
  store.put(l2);
  store.put(l3);
  idx.blockBecameCanonical(genesis);
  idx.blockBecameCanonical(anchor);
  idx.blockBecameCanonical(l1);
  idx.blockBecameCanonical(l2);
  idx.blockBecameCanonical(l3);

  // Build the agg block. It needs an AGG result output (data carries
  // AggregationData) plus the agg-marker for itself.
  //
  // Aggregate order [L1, L2, L3] -- OutputSpaceModule walks them in
  // reverse for extended-vector composition: own ++ L3.new ++ L2.new
  // ++ L1.new ++ output_space(anchor).
  //
  // Each leaf has 2 own outputs and no self-claim, so newOutputCount=2
  // and aggregateOutputCounts=[2,2,2]. Anchor's output_space has its
  // own 2 outputs (no anchor self-claims) plus genesis's 1; total 3.
  //
  // We want to claim:
  //   - L3's AGG marker  -> ext idx 2 (own=2, then L3.new[0])
  //   - L2's AGG marker  -> ext idx 4 (after L3.new)
  //   - L1's AGG marker  -> ext idx 6
  //   - Anchor's AGG marker -> ext idx 8 (after L1.new, in anchor.output_space at position 0)
  const aggData = encodeAggregationData({
    claimMask: [0], // anchor.output_space position 0 (the AGG marker) consumed by subtree
    newOutputCount: 2 + 6 + 2 - 4, // own(2) + agg(6) + anchor.surviving(2). placeholder.
    aggregateOutputCounts: [2, 2, 2],
    chainWeights: [],
    aggregateWeights: [],
  });

  const aggBlock = makeBlock({
    name: 'AggBlock',
    anchor: anchor.hash,
    aggregates: [l1.hash, l2.hash, l3.hash],
    outputs: [
      // Aggregation contract result with the encoded data.
      {
        verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
        value: 0,
        body: aggData,
      },
      makeAggregationOutput(), // marker for self
    ],
    // Claim positions in extended vector =
    //   own(2) ++ L3.new(2) ++ L2.new(2) ++ L1.new(2) ++ anchor.output_space(3)
    // We claim: L3's marker (idx 2), L2's marker (idx 4), L1's marker
    // (idx 6), anchor's AGG marker (idx 8).
    claimIndices: [2, 4, 6, 8],
  });

  store.put(aggBlock);
  idx.blockBecameCanonical(aggBlock);

  // The four AGG markers should be gone from the index.
  assertEquals(isUnspent(idx, anchor, 0), false, 'anchor AGG marker must be spent');
  assertEquals(isUnspent(idx, l1, 0), false, 'L1 AGG marker must be spent');
  assertEquals(isUnspent(idx, l2, 0), false, 'L2 AGG marker must be spent');
  assertEquals(isUnspent(idx, l3, 0), false, 'L3 AGG marker must be spent');

  // The SIG outputs (anchor's keep-me, leaves' l*-keep, genesis's g)
  // must NOT have been touched by the agg block's claims.
  assertEquals(isUnspent(idx, anchor, 1), true, 'anchor SIG must remain (not anchor.output_space slot 0)');
  assertEquals(isUnspent(idx, l1, 1), true, 'L1 SIG must remain');
  assertEquals(isUnspent(idx, l2, 1), true, 'L2 SIG must remain');
  assertEquals(isUnspent(idx, l3, 1), true, 'L3 SIG must remain');
  assertEquals(isUnspent(idx, genesis, 0), true, 'genesis SIG must remain');
});

Deno.test('UtxoIndex: claim resolution survives a non-canonical → canonical flip cycle', () => {
  // Pin re-add symmetry: dropping a claim must restore the same
  // (block, outputIndex) the canonical-pass removed, which only
  // matches if both directions go through OutputSpaceModule.
  const store = new BlockStore();
  const idx = new UtxoIndex(store);

  const genesis = makeBlock({
    name: 'genesis-2',
    outputs: [sigOut('g0', 100), sigOut('g1', 200), sigOut('g2', 300)],
  });
  const a = makeBlock({
    name: 'A2',
    anchor: genesis.hash,
    outputs: [sigOut('a0', 50), recordOut('meta'), sigOut('a1', 999)],
    claimIndices: [1, 3], // self-claim RECORD + external g0
  });
  const b = makeBlock({
    name: 'B2',
    anchor: a.hash,
    outputs: [],
    claimIndices: [1], // claims a1 via output_space(A)[1]
  });

  store.put(genesis);
  store.put(a);
  store.put(b);
  idx.blockBecameCanonical(genesis);
  idx.blockBecameCanonical(a);
  idx.blockBecameCanonical(b);

  assert(!isUnspent(idx, a, 2), 'a1 spent after B canonical');

  idx.blockBecameNonCanonical(b);
  assert(isUnspent(idx, a, 2), 'a1 must be re-added when B leaves canonical');

  idx.blockBecameCanonical(b);
  assert(!isUnspent(idx, a, 2), 'a1 spent again on re-canonicalization');
});

// -- Sanity: verifierKey lookup matches what the index stores --------

Deno.test('UtxoIndex: getByVerifier finds outputs added by blockBecameCanonical', () => {
  const store = new BlockStore();
  const idx = new UtxoIndex(store);
  const genesis = makeBlock({ name: 'g3', outputs: [sigOut('g', 100)] });
  store.put(genesis);
  idx.blockBecameCanonical(genesis);
  const entries = idx.getByVerifier(SIGNATURE_CONTRACT, enc('g'));
  assertEquals(entries.length, 1);
  assertEquals(entries[0].value, 100);
  assertEquals(verifierKey(SIGNATURE_CONTRACT, enc('g')).startsWith(SIGNATURE_CONTRACT.toHex()), true);
});
