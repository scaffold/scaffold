import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { PlacementModule, PlacementProvider } from '../src/core/PlacementModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  aggregates: Hash[];
}

class TestProvider implements PlacementProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();
  private canonicalAgg = new Map<HashPrimitive, Hash>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
  }

  /** Declare that `parent` canonically aggregates `child`. */
  setCanonicalAggregator(child: Hash, parent: Hash): void {
    this.canonicalAgg.set(child.toPrimitive(), parent);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }
  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }
  getAggregates(block: TestBlock): Hash[] {
    return block.aggregates;
  }
  getCanonicalAggregator(hash: Hash): Hash | undefined {
    return this.canonicalAgg.get(hash.toPrimitive());
  }
}

const h = (name: string): Hash => Hash.digest(name);

function setup(): { provider: TestProvider; module: PlacementModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new PlacementModule(provider);
  return { provider, module };
}

function block(name: string, anchor: Hash, aggregates: Hash[] = []): TestBlock {
  return { hash: h(name), anchor, aggregates };
}

// -- Single-claim degenerate case --------------------------------

Deno.test('single claim: claim block is the anchor', () => {
  const { provider, module } = setup();
  const G = block('G', ZERO_HASH);
  const A = block('A', G.hash);
  provider.add(G);
  provider.add(A);

  const result = module.place({
    claimedBlocks: [A.hash],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });

  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), A.hash.toPrimitive());
});

// -- Empty inputs ------------------------------------------------

Deno.test('empty inputs: stalled', () => {
  const { module } = setup();
  const result = module.place({
    claimedBlocks: [],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });
  assert(!result.ok);
  assert(result.stalled);
});

// -- E1: jointly-aggregated claims -------------------------------

Deno.test('E1: claims X,Y jointly aggregated by Z -> anchor Z', () => {
  const { provider, module } = setup();
  // G <- X, G <- Y, G <- Z (Z aggregates X and Y)
  const G = block('G', ZERO_HASH);
  const X = block('X', G.hash);
  const Y = block('Y', G.hash);
  const Z = block('Z', G.hash, [X.hash, Y.hash]);
  provider.add(G);
  provider.add(X);
  provider.add(Y);
  provider.add(Z);
  provider.setCanonicalAggregator(X.hash, Z.hash);
  provider.setCanonicalAggregator(Y.hash, Z.hash);

  const result = module.place({
    claimedBlocks: [X.hash, Y.hash],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });

  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), Z.hash.toPrimitive());
});

// -- E2: disjoint aggregation trees ------------------------------

Deno.test('E2: claims X,Y in disjoint trees -> stalled', () => {
  const { provider, module } = setup();
  // G <- X, G <- Zx (aggregates X)
  // G <- Y, G <- Zy (aggregates Y)
  const G = block('G', ZERO_HASH);
  const X = block('X', G.hash);
  const Zx = block('Zx', G.hash, [X.hash]);
  const Y = block('Y', G.hash);
  const Zy = block('Zy', G.hash, [Y.hash]);
  for (const b of [G, X, Zx, Y, Zy]) provider.add(b);
  provider.setCanonicalAggregator(X.hash, Zx.hash);
  provider.setCanonicalAggregator(Y.hash, Zy.hash);

  const result = module.place({
    claimedBlocks: [X.hash, Y.hash],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });

  assert(!result.ok);
  assert(result.stalled);
});

// -- E3: sibling-aggregation pre-processing ----------------------

Deno.test('E3: aggregating {C,D} in G<-A<-B<-C<-D -> anchor B', () => {
  const { provider, module } = setup();
  const G = block('G', ZERO_HASH);
  const A = block('A', G.hash);
  const B = block('B', A.hash);
  const C = block('C', B.hash);
  const D = block('D', C.hash);
  for (const b of [G, A, B, C, D]) provider.add(b);
  // No canonical aggregator for any of these -- this draft is producing the
  // aggregation, so canonically C, D aren't aggregated yet.

  const result = module.place({
    claimedBlocks: [],
    aggregatedBlocks: [C.hash, D.hash],
    excludedBlocks: [],
  });

  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), B.hash.toPrimitive());
});

Deno.test('E3: pre-processing handles aggregating just leaf D in G<-A<-B<-C<-D', () => {
  const { provider, module } = setup();
  const G = block('G', ZERO_HASH);
  const A = block('A', G.hash);
  const B = block('B', A.hash);
  const C = block('C', B.hash);
  const D = block('D', C.hash);
  for (const b of [G, A, B, C, D]) provider.add(b);

  const result = module.place({
    claimedBlocks: [],
    aggregatedBlocks: [D.hash],
    excludedBlocks: [],
  });

  // Only D in aggregatedSet, so outsideAnchor(D) walks one step to C.
  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), C.hash.toPrimitive());
});

// -- E4: subsumed claim is dropped --------------------------------

Deno.test('E4: claim on X is subsumed when X canonically aggregated by C in aggregatedBlocks', () => {
  const { provider, module } = setup();
  // G <- X, and C canonically aggregates X.
  // The draft is aggregating C; the claim on X is subsumed.
  const G = block('G', ZERO_HASH);
  const X = block('X', G.hash);
  const C = block('C', G.hash, [X.hash]);
  for (const b of [G, X, C]) provider.add(b);
  provider.setCanonicalAggregator(X.hash, C.hash);

  // Pre-process: aggregatedBlocks = {C}. outsideAnchor(C) = G.
  // Claim on X: aggregationChain(X) = [X, C]. C is in aggregatedSet -> drop.
  // includeBlocks = {G}.
  const result = module.place({
    claimedBlocks: [X.hash],
    aggregatedBlocks: [C.hash],
    excludedBlocks: [],
  });

  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), G.hash.toPrimitive());
});

Deno.test('E4 negative control: without subsume drop, the algorithm would stall or err', () => {
  // Same topology but verify we get a sensible answer when X is NOT subsumed
  // (no aggregatedBlocks). Anchor should be X itself.
  const { provider, module } = setup();
  const G = block('G', ZERO_HASH);
  const X = block('X', G.hash);
  const C = block('C', G.hash, [X.hash]);
  for (const b of [G, X, C]) provider.add(b);
  provider.setCanonicalAggregator(X.hash, C.hash);

  const result = module.place({
    claimedBlocks: [X.hash],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });
  assert(result.ok);
  // With single claim and X canonically aggregated by C, the algorithm walks
  // X's aggregation chain: [X, C]. X.anchorChain reaches Cx={X,C} at X. So X
  // qualifies and is selected first.
  assertEquals(result.anchor.toPrimitive(), X.hash.toPrimitive());
});

// -- E5: exclude constraints --------------------------------------

Deno.test('E5: exclude Y on X lineage forces stall', () => {
  const { provider, module } = setup();
  // G <- Y <- X. We claim X but exclude Y (Y is on X's anchor chain).
  // No K in Cx has an anchor chain that bypasses Y.
  const G = block('G', ZERO_HASH);
  const Y = block('Y', G.hash);
  const X = block('X', Y.hash);
  for (const b of [G, Y, X]) provider.add(b);

  const result = module.place({
    claimedBlocks: [X.hash],
    aggregatedBlocks: [],
    excludedBlocks: [Y.hash],
  });

  assert(!result.ok);
  assert(result.stalled);
});

Deno.test('E5b: exclude Y on a separate branch is satisfied', () => {
  const { provider, module } = setup();
  // G <- Y (separate branch), G <- X. We claim X and exclude Y.
  // X.anchorChain = [X, G] does not hit Y. Anchor = X.
  const G = block('G', ZERO_HASH);
  const Y = block('Y', G.hash);
  const X = block('X', G.hash);
  for (const b of [G, Y, X]) provider.add(b);

  const result = module.place({
    claimedBlocks: [X.hash],
    aggregatedBlocks: [],
    excludedBlocks: [Y.hash],
  });

  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), X.hash.toPrimitive());
});

// -- Aggregation chain canonicality ------------------------------

Deno.test('aggregation chain walks transitively through canonical aggregators', () => {
  // X aggregated by Z1, Z1 aggregated by Z2.
  // Claims on X and on a distant block Y, with Z2 also covering Y.
  // The algorithm should walk Cx = [X, Z1, Z2] until Z2 to find common anchor.
  const { provider, module } = setup();
  const G = block('G', ZERO_HASH);
  const X = block('X', G.hash);
  const Y = block('Y', G.hash);
  const Z1 = block('Z1', G.hash, [X.hash]);
  const Z2 = block('Z2', G.hash, [Z1.hash, Y.hash]);
  for (const b of [G, X, Y, Z1, Z2]) provider.add(b);
  provider.setCanonicalAggregator(X.hash, Z1.hash);
  provider.setCanonicalAggregator(Z1.hash, Z2.hash);
  provider.setCanonicalAggregator(Y.hash, Z2.hash);

  const result = module.place({
    claimedBlocks: [X.hash, Y.hash],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });
  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), Z2.hash.toPrimitive());
});

// -- Combined: claims + aggregates ------------------------------

Deno.test('combined claims and aggregatedBlocks: anchor satisfies both constraints', () => {
  const { provider, module } = setup();
  // G <- A <- B <- C
  // Claim on A, aggregating C.
  // Pass 1: outsideAnchor(C) = B. includes = {A, B}.
  // Cb = [B], Ca = [A]. Main loop:
  //   from Cb: B.anchorChain = [B, A, G]. Hits Cb at B. Hits Ca at A. -> B
  //   from Ca: A.anchorChain = [A, G]. Hits Ca at A. Hits Cb? No (B is not in [A, G]).
  //                 Walk Ca further: Ca = [A] only. Null.
  // Set = {B}. Anchor = B.
  const G = block('G', ZERO_HASH);
  const A = block('A', G.hash);
  const B = block('B', A.hash);
  const C = block('C', B.hash);
  for (const b of [G, A, B, C]) provider.add(b);

  const result = module.place({
    claimedBlocks: [A.hash],
    aggregatedBlocks: [C.hash],
    excludedBlocks: [],
  });
  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), B.hash.toPrimitive());
});

// -- Cycle resilience -------------------------------------------

Deno.test('aggregation chain with cycle terminates without error', () => {
  // Adversarial: setCanonicalAggregator pointing back to itself. The walk
  // must not loop forever even if the canonical view is malformed.
  const { provider, module } = setup();
  const G = block('G', ZERO_HASH);
  const X = block('X', G.hash);
  for (const b of [G, X]) provider.add(b);
  provider.setCanonicalAggregator(X.hash, X.hash);

  const result = module.place({
    claimedBlocks: [X.hash],
    aggregatedBlocks: [],
    excludedBlocks: [],
  });
  // Single claim still resolves to X regardless of the bogus self-loop.
  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), X.hash.toPrimitive());
});

// -- Pre-processing edge: aggregated block with missing anchor block ----

Deno.test('pre-processing fails gracefully when anchor block missing', () => {
  const { provider, module } = setup();
  // C in aggregatedBlocks, but C's anchor block isn't in the store.
  const C = block('C', h('missing-anchor'));
  provider.add(C);
  // Note: missing-anchor not added.

  const result = module.place({
    claimedBlocks: [],
    aggregatedBlocks: [C.hash],
    excludedBlocks: [],
  });
  // outsideAnchor walks C -> missing-anchor; missing-anchor is not in
  // aggregatedSet, so it returns missing-anchor as the outside anchor.
  // Then includeBlocks = [missing-anchor]. Main loop tries to walk
  // anchorChain of missing-anchor, which fails since the block is missing.
  // The chain returns just [missing-anchor]. Its anchor chain set is
  // {missing-anchor}, which intersects Cb = [missing-anchor] at itself.
  // So the algorithm picks missing-anchor as the anchor. This is the
  // contract: placement assumes the include set's anchor chains exist; a
  // missing block produces a degraded but non-error result.
  assert(result.ok);
  assertEquals(result.anchor.toPrimitive(), h('missing-anchor').toPrimitive());
});
