import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import {
  OutputClaimEntry,
  OutputClaimModule,
  OutputClaimProvider,
} from '../src/core/OutputClaimModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  ownOutputCount: number;
  aggregateHashes: Hash[];
  aggregateOutputCounts: number[];
}

class TestProvider implements OutputClaimProvider<TestBlock> {
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

  getOwnOutputCount(block: TestBlock): number {
    return block.ownOutputCount;
  }

  getAggregateHashes(block: TestBlock): Hash[] {
    return block.aggregateHashes;
  }

  getAggregateOutputCounts(block: TestBlock): number[] {
    return block.aggregateOutputCounts;
  }
}

const h = (name: string): Hash => Hash.digest(name);

function genesis(hash: Hash, outputCount: number): TestBlock {
  return {
    hash,
    anchor: ZERO_HASH,
    ownOutputCount: outputCount,
    aggregateHashes: [],
    aggregateOutputCounts: [],
  };
}

function leaf(opts: {
  hash: Hash;
  anchor: Hash;
  ownOutputCount: number;
}): TestBlock {
  return {
    hash: opts.hash,
    anchor: opts.anchor,
    ownOutputCount: opts.ownOutputCount,
    aggregateHashes: [],
    aggregateOutputCounts: [],
  };
}

function aggregator(opts: {
  hash: Hash;
  anchor: Hash;
  ownOutputCount: number;
  aggregateHashes: Hash[];
  aggregateOutputCounts: number[];
}): TestBlock {
  return { ...opts };
}

function setup(...blocks: TestBlock[]) {
  const provider = new TestProvider();
  for (const b of blocks) provider.add(b);
  const module = new OutputClaimModule(provider);
  return { provider, module };
}

function getEntries(
  module: OutputClaimModule<TestBlock>,
  hash: Hash,
): Map<number, readonly OutputClaimEntry[]> | undefined {
  return module.getClaims(hash) as Map<number, readonly OutputClaimEntry[]> | undefined;
}

// -- Tests -------------------------------------------------------

Deno.test('OutputClaimModule', async (t) => {
  // ---------------------------------------------------------------
  // Self-claim resolves immediately
  // ---------------------------------------------------------------
  await t.step('self-claim resolves immediately', () => {
    // Block C has 3 outputs, claims index 0 (self-claim)
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 3 });
    const { module } = setup(G, C);

    const resolved = module.addBlock(C.hash, [0]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, C.hash), true);
    assertEquals(resolved[0].outputIndex, 0);
  });

  // ---------------------------------------------------------------
  // Claim on anchor's output resolves immediately (anchor loaded)
  // ---------------------------------------------------------------
  await t.step('claim on anchor output resolves when anchor loaded', () => {
    // G has 5 outputs. C has 2 outputs, claims index 2 (own output space).
    // C's output space: [C.out0, C.out1, G.out0, G.out1, G.out2, G.out3, G.out4]
    // Index 2 = C's 3rd slot = G's output 0.
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 2 });
    const { module } = setup(G, C);

    const resolved = module.addBlock(C.hash, [2]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 0);
  });

  // ---------------------------------------------------------------
  // Claim on anchor output at higher index
  // ---------------------------------------------------------------
  await t.step('claim maps to correct anchor output index', () => {
    // G has 5 outputs. C has 2 outputs.
    // C's output space: [C0, C1, G0, G1, G2, G3, G4]
    // Claim index 5 -> G's output 3.
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 2 });
    const { module } = setup(G, C);

    const resolved = module.addBlock(C.hash, [5]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 3);
  });

  // ---------------------------------------------------------------
  // Stuck claim: anchor not loaded, resolves when loaded
  // ---------------------------------------------------------------
  await t.step('stuck claim resolves when anchor loads', () => {
    // C anchors to G, but G not loaded yet
    const C = leaf({ hash: h('C'), anchor: h('G'), ownOutputCount: 2 });
    const { provider, module } = setup(C);

    // Claim index 3 -> should be G's output 1, but G not loaded
    const resolved = module.addBlock(C.hash, [3]);
    assertEquals(resolved.length, 0);

    // Entry should be stuck on C
    const claims = getEntries(module, C.hash);
    assertEquals(claims?.size, 1);
    assertEquals(claims?.get(3)?.length, 1);

    // Now load G
    const G = genesis(h('G'), 5);
    provider.add(G);
    const resolvedAfter = module.onBlockLoaded(G.hash);
    assertEquals(resolvedAfter.length, 1);
    assertEquals(Hash.equals(resolvedAfter[0].block, G.hash), true);
    assertEquals(resolvedAfter[0].outputIndex, 1);

    // Entry should have moved from C to G (and resolved)
    assertEquals(getEntries(module, C.hash), undefined);
  });

  // ---------------------------------------------------------------
  // Claim through aggregate: migrates to correct subtree
  // ---------------------------------------------------------------
  await t.step('claim through aggregate migrates to subtree', () => {
    // G has 10 outputs.
    // S1 has 3 outputs (subtree 1).
    // S2 has 4 outputs (subtree 2).
    // A is an aggregator with 1 own output, aggregates [S1, S2].
    // A's output space (aggregates in reverse):
    //   [A.out0, S2.out0..3, S1.out0..2, G.surviving...]
    //   Index 0 = A's own
    //   Index 1..4 = S2's outputs (last aggregate first)
    //   Index 5..7 = S1's outputs
    //   Index 8+ = G's surviving outputs
    const G = genesis(h('G'), 10);
    const S1 = leaf({ hash: h('S1'), anchor: G.hash, ownOutputCount: 3 });
    const S2 = leaf({ hash: h('S2'), anchor: G.hash, ownOutputCount: 4 });
    const A = aggregator({
      hash: h('A'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash, S2.hash],
      aggregateOutputCounts: [3, 4],
    });

    const { module } = setup(G, S1, S2, A);

    // Claim index 3 on A -> S2's output at index 2 (within S2's range)
    const resolved1 = module.addBlock(A.hash, [3]);
    assertEquals(resolved1.length, 1);
    assertEquals(Hash.equals(resolved1[0].block, S2.hash), true);
    assertEquals(resolved1[0].outputIndex, 2);

    // Claim index 6 on A -> S1's output at index 1
    // Index 6: subtract own(1), remaining 5. S2 has 4, so 5-4=1. S1 range, local index 1.
    const A2 = aggregator({
      hash: h('A2'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash, S2.hash],
      aggregateOutputCounts: [3, 4],
    });
    const { module: module2 } = setup(G, S1, S2, A2);
    const resolved2 = module2.addBlock(A2.hash, [6]);
    assertEquals(resolved2.length, 1);
    assertEquals(Hash.equals(resolved2[0].block, S1.hash), true);
    assertEquals(resolved2[0].outputIndex, 1);
  });

  // ---------------------------------------------------------------
  // Claim past all aggregates maps to anchor
  // ---------------------------------------------------------------
  await t.step('claim past aggregates maps to anchor', () => {
    const G = genesis(h('G'), 10);
    const S1 = leaf({ hash: h('S1'), anchor: G.hash, ownOutputCount: 3 });
    const A = aggregator({
      hash: h('A'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash],
      aggregateOutputCounts: [3],
    });

    const { module } = setup(G, S1, A);

    // A's output space: [A.out0, S1.out0..2, G.out0..9]
    // Index 4 = G's output 0 (subtract own 1, S1 3 -> remaining 0)
    const resolved = module.addBlock(A.hash, [4]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 0);

    // Index 10 = G's output 6
    const A2 = aggregator({
      hash: h('A2'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash],
      aggregateOutputCounts: [3],
    });
    const { module: module2 } = setup(G, S1, A2);
    const resolved2 = module2.addBlock(A2.hash, [10]);
    assertEquals(resolved2.length, 1);
    assertEquals(Hash.equals(resolved2[0].block, G.hash), true);
    assertEquals(resolved2[0].outputIndex, 6);
  });

  // ---------------------------------------------------------------
  // Stuck aggregate claim resolves when subtree loads
  // ---------------------------------------------------------------
  await t.step('stuck aggregate claim resolves when subtree loads', () => {
    const G = genesis(h('G'), 10);
    // S1 not loaded yet
    const A = aggregator({
      hash: h('A'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [h('S1')],
      aggregateOutputCounts: [3],
    });

    const { provider, module } = setup(G, A);

    // Claim index 2 on A -> should go to S1 at index 1, but S1 not loaded
    const resolved = module.addBlock(A.hash, [2]);
    assertEquals(resolved.length, 0);

    // Entry stuck on A
    const claims = getEntries(module, A.hash);
    assertEquals(claims?.get(2)?.length, 1);

    // Load S1
    const S1 = leaf({ hash: h('S1'), anchor: G.hash, ownOutputCount: 3 });
    provider.add(S1);
    const resolvedAfter = module.onBlockLoaded(S1.hash);
    assertEquals(resolvedAfter.length, 1);
    assertEquals(Hash.equals(resolvedAfter[0].block, S1.hash), true);
    assertEquals(resolvedAfter[0].outputIndex, 1);
  });

  // ---------------------------------------------------------------
  // Multiple claimants on same output
  // ---------------------------------------------------------------
  await t.step('multiple claimants tracked on same output', () => {
    const G = genesis(h('G'), 5);
    const C1 = leaf({ hash: h('C1'), anchor: G.hash, ownOutputCount: 1 });
    const C2 = leaf({ hash: h('C2'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, C1, C2);

    // Both claim G's output 0 (index 1 in their own output space: own 1 + G's index 0)
    module.addBlock(C1.hash, [1]);
    module.addBlock(C2.hash, [1]);

    // G should have 2 entries at index 0
    const gClaims = getEntries(module, G.hash);
    assertEquals(gClaims?.get(0)?.length, 2);

    const claimants = gClaims!.get(0)!.map((e) => e.claimant);
    assertEquals(
      claimants.some((c) => Hash.equals(c, C1.hash)),
      true,
    );
    assertEquals(
      claimants.some((c) => Hash.equals(c, C2.hash)),
      true,
    );
  });

  // ---------------------------------------------------------------
  // Recursive migration through chain
  // ---------------------------------------------------------------
  await t.step('recursive migration through anchor chain', () => {
    // G -> A -> B. B claims something deep in G.
    // B has 1 output, anchors to A. A has 2 outputs, anchors to G. G has 5 outputs.
    // B's output space: [B.out0, A.out0, A.out1, G.out0..4]
    // Index 4 = G's output 1 (subtract B.own 1, A.own 2 -> remaining 1)
    const G = genesis(h('G'), 5);
    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 2 });
    const B = leaf({ hash: h('B'), anchor: A.hash, ownOutputCount: 1 });
    const { module } = setup(G, A, B);

    const resolved = module.addBlock(B.hash, [4]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 1);
  });

  // ---------------------------------------------------------------
  // Recursive migration: middle block not loaded, then loaded
  // ---------------------------------------------------------------
  await t.step('migration through chain with late-loading middle block', () => {
    // G -> A -> B. B claims G.out[2].
    // B has 1 output, A has 2 outputs, G has 5 outputs.
    // B's output space: [B.out0, A.out0, A.out1, G.out0..4]
    // Index 5 = G.out[2]
    const G = genesis(h('G'), 5);
    const B = leaf({ hash: h('B'), anchor: h('A'), ownOutputCount: 1 });
    const { provider, module } = setup(G, B);

    // A not loaded
    const resolved = module.addBlock(B.hash, [5]);
    assertEquals(resolved.length, 0);

    // Stuck on B at index 5
    assertEquals(getEntries(module, B.hash)?.get(5)?.length, 1);

    // Load A
    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 2 });
    provider.add(A);
    const resolvedAfter = module.onBlockLoaded(A.hash);
    assertEquals(resolvedAfter.length, 1);
    assertEquals(Hash.equals(resolvedAfter[0].block, G.hash), true);
    assertEquals(resolvedAfter[0].outputIndex, 2);

    // Entry migrated all the way through
    assertEquals(getEntries(module, B.hash), undefined);
  });

  // ---------------------------------------------------------------
  // Connected component: loading block connects two segments
  // ---------------------------------------------------------------
  await t.step('loading a block connects previously disconnected segments', () => {
    // G -> A -> B -> C. C claims G.out[0].
    // A and G loaded, B not loaded.
    // C has 1 output, B has 1 output, A has 1 output, G has 3 outputs.
    // C's output space: [C.out0, B.out0, A.out0, G.out0, G.out1, G.out2]
    // Index 3 = G.out[0]
    const G = genesis(h('G'), 3);
    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 1 });
    const C = leaf({ hash: h('C'), anchor: h('B'), ownOutputCount: 1 });
    const { provider, module } = setup(G, A, C);

    const resolved = module.addBlock(C.hash, [3]);
    assertEquals(resolved.length, 0);

    // Stuck on C
    assertEquals(getEntries(module, C.hash)?.get(3)?.length, 1);

    // Load B -- should trigger full migration through A to G
    const B = leaf({ hash: h('B'), anchor: A.hash, ownOutputCount: 1 });
    provider.add(B);
    const resolvedAfter = module.onBlockLoaded(B.hash);
    assertEquals(resolvedAfter.length, 1);
    assertEquals(Hash.equals(resolvedAfter[0].block, G.hash), true);
    assertEquals(resolvedAfter[0].outputIndex, 0);

    assertEquals(getEntries(module, C.hash), undefined);
  });

  // ---------------------------------------------------------------
  // Multiple claims on same block
  // ---------------------------------------------------------------
  await t.step('multiple claims from same block', () => {
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 2 });
    const { module } = setup(G, C);

    // C claims: index 0 (self), index 2 (G.out[0]), index 4 (G.out[2])
    const resolved = module.addBlock(C.hash, [0, 2, 4]);
    assertEquals(resolved.length, 3);

    // Self-claim
    assertEquals(Hash.equals(resolved[0].block, C.hash), true);
    assertEquals(resolved[0].outputIndex, 0);

    // G.out[0]
    assertEquals(Hash.equals(resolved[1].block, G.hash), true);
    assertEquals(resolved[1].outputIndex, 0);

    // G.out[2]
    assertEquals(Hash.equals(resolved[2].block, G.hash), true);
    assertEquals(resolved[2].outputIndex, 2);
  });

  // ---------------------------------------------------------------
  // getClaimantsAt query
  // ---------------------------------------------------------------
  await t.step('getClaimantsAt returns correct entries', () => {
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, C);

    module.addBlock(C.hash, [1]); // G.out[0]

    const claimants = module.getClaimantsAt(G.hash, 0);
    assertEquals(claimants?.length, 1);
    assertEquals(Hash.equals(claimants![0].claimant, C.hash), true);
    assertEquals(claimants![0].claimIndex, 0);

    // No claimants at index 1
    assertEquals(module.getClaimantsAt(G.hash, 1), undefined);
  });

  // ---------------------------------------------------------------
  // Nested aggregation: aggregator of aggregator
  // ---------------------------------------------------------------
  await t.step('nested aggregation migration', () => {
    // G has 10 outputs.
    // S1 is a leaf with 2 outputs.
    // A1 aggregates S1, has 1 own output, aggregateOutputCounts=[2].
    // A2 aggregates A1, has 1 own output, aggregateOutputCounts=[outputCount of A1].
    // A1's output count (as seen by A2's aggregate slot) = A1's own(1) + S1(2) = 3
    // Wait -- aggregateOutputCounts is how many outputs the aggregate contributes
    // to the parent's output space. That's A1's total output count.
    // Actually, let me think about what aggregateOutputCounts means here.
    // From AggregationData: it's per-subtree output counts.
    // For A2 aggregating A1: A1's output count is its total visible outputs.
    // A1 has 1 own + 2 from S1 + (G's 10 - whatever A1 claims from G).
    // For simplicity, let's say A1 claims nothing from G.
    // A1 total outputs = 1 + 2 + 10 = 13? No, that's not right either.
    // getOutputCount for A1: it's computed by BlockCreation. Let me just set it directly.
    // For this test, A1's newOutputCount as seen by A2 = let's say 3 (1 own + 2 from S1).
    // But that's only if A1 claims all of G's outputs. Let me simplify:
    // S1 is a subtree of A1. S1 has 2 outputs.
    // A1 aggregates [S1], ownOutputCount=1, aggregateOutputCounts=[2]
    // So A1's output space: [A1.out0, S1.out0, S1.out1, G.out0..9]
    // A1's "output count" for A2's perspective: we just say it directly.

    const G = genesis(h('G'), 10);
    const S1 = leaf({ hash: h('S1'), anchor: G.hash, ownOutputCount: 2 });
    const A1 = aggregator({
      hash: h('A1'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash],
      aggregateOutputCounts: [2],
    });

    // A2 aggregates A1. A1 contributes 3 outputs (1 own + 2 from S1)
    // to A2's output space (just the outputs that A1 itself has, not the pass-through).
    // Actually, the aggregateOutputCounts for A2 should be A1's total output count
    // as reported by getOutputCount -- but we don't have that in our provider.
    // For our test block model, aggregateOutputCounts is what we set.
    // Let's say A1 contributes 3 outputs to A2's space.
    const A2 = aggregator({
      hash: h('A2'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [A1.hash],
      aggregateOutputCounts: [3], // A1 contributes 3 outputs
    });

    const { module } = setup(G, S1, A1, A2);

    // A2's output space: [A2.out0, A1's 3 outputs, G.out0..9]
    // A1's 3 outputs: [A1.out0, S1.out0, S1.out1]
    // Claim index 2 on A2: subtract own(1) -> remaining 1.
    // Last aggregate (A1) has 3, 1 < 3 -> goes to A1 at index 1.
    // On A1: index 1 -> subtract own(1) -> remaining 0.
    // Last aggregate (S1) has 2, 0 < 2 -> goes to S1 at index 0.
    // On S1: index 0 < ownOutputCount(2) -> resolved! S1.out[0].
    const resolved = module.addBlock(A2.hash, [2]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, S1.hash), true);
    assertEquals(resolved[0].outputIndex, 0);
  });
});
