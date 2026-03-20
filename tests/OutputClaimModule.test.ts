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

/** Check whether a conflict pair list contains a specific pair (order-independent). */
function hasConflictPair(
  conflicts: [Hash, Hash][],
  a: Hash,
  b: Hash,
): boolean {
  return conflicts.some(
    ([x, y]) =>
      (Hash.equals(x, a) && Hash.equals(y, b)) ||
      (Hash.equals(x, b) && Hash.equals(y, a)),
  );
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

    const { resolved } = module.addBlock(C.hash, [0]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, C.hash), true);
    assertEquals(resolved[0].outputIndex, 0);
  });

  // ---------------------------------------------------------------
  // Claim on anchor's output resolves immediately (anchor loaded)
  // ---------------------------------------------------------------
  await t.step('claim on anchor output resolves when anchor loaded', () => {
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 2 });
    const { module } = setup(G, C);

    const { resolved } = module.addBlock(C.hash, [2]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 0);
  });

  // ---------------------------------------------------------------
  // Claim on anchor output at higher index
  // ---------------------------------------------------------------
  await t.step('claim maps to correct anchor output index', () => {
    const G = genesis(h('G'), 5);
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 2 });
    const { module } = setup(G, C);

    const { resolved } = module.addBlock(C.hash, [5]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 3);
  });

  // ---------------------------------------------------------------
  // Stuck claim: anchor not loaded, resolves when loaded
  // ---------------------------------------------------------------
  await t.step('stuck claim resolves when anchor loads', () => {
    const C = leaf({ hash: h('C'), anchor: h('G'), ownOutputCount: 2 });
    const { provider, module } = setup(C);

    const { resolved } = module.addBlock(C.hash, [3]);
    assertEquals(resolved.length, 0);

    const claims = getEntries(module, C.hash);
    assertEquals(claims?.size, 1);
    assertEquals(claims?.get(3)?.length, 1);

    const G = genesis(h('G'), 5);
    provider.add(G);
    const { resolved: resolvedAfter } = module.onBlockLoaded(G.hash);
    assertEquals(resolvedAfter.length, 1);
    assertEquals(Hash.equals(resolvedAfter[0].block, G.hash), true);
    assertEquals(resolvedAfter[0].outputIndex, 1);

    assertEquals(getEntries(module, C.hash), undefined);
  });

  // ---------------------------------------------------------------
  // Claim through aggregate: migrates to correct subtree
  // ---------------------------------------------------------------
  await t.step('claim through aggregate migrates to subtree', () => {
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

    const { resolved: resolved1 } = module.addBlock(A.hash, [3]);
    assertEquals(resolved1.length, 1);
    assertEquals(Hash.equals(resolved1[0].block, S2.hash), true);
    assertEquals(resolved1[0].outputIndex, 2);

    const A2 = aggregator({
      hash: h('A2'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash, S2.hash],
      aggregateOutputCounts: [3, 4],
    });
    const { module: module2 } = setup(G, S1, S2, A2);
    const { resolved: resolved2 } = module2.addBlock(A2.hash, [6]);
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

    const { resolved } = module.addBlock(A.hash, [4]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 0);

    const A2 = aggregator({
      hash: h('A2'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash],
      aggregateOutputCounts: [3],
    });
    const { module: module2 } = setup(G, S1, A2);
    const { resolved: resolved2 } = module2.addBlock(A2.hash, [10]);
    assertEquals(resolved2.length, 1);
    assertEquals(Hash.equals(resolved2[0].block, G.hash), true);
    assertEquals(resolved2[0].outputIndex, 6);
  });

  // ---------------------------------------------------------------
  // Stuck aggregate claim resolves when subtree loads
  // ---------------------------------------------------------------
  await t.step('stuck aggregate claim resolves when subtree loads', () => {
    const G = genesis(h('G'), 10);
    const A = aggregator({
      hash: h('A'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [h('S1')],
      aggregateOutputCounts: [3],
    });

    const { provider, module } = setup(G, A);

    const { resolved } = module.addBlock(A.hash, [2]);
    assertEquals(resolved.length, 0);

    const claims = getEntries(module, A.hash);
    assertEquals(claims?.get(2)?.length, 1);

    const S1 = leaf({ hash: h('S1'), anchor: G.hash, ownOutputCount: 3 });
    provider.add(S1);
    const { resolved: resolvedAfter } = module.onBlockLoaded(S1.hash);
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

    module.addBlock(C1.hash, [1]);
    module.addBlock(C2.hash, [1]);

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
    const G = genesis(h('G'), 5);
    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 2 });
    const B = leaf({ hash: h('B'), anchor: A.hash, ownOutputCount: 1 });
    const { module } = setup(G, A, B);

    const { resolved } = module.addBlock(B.hash, [4]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, G.hash), true);
    assertEquals(resolved[0].outputIndex, 1);
  });

  // ---------------------------------------------------------------
  // Recursive migration: middle block not loaded, then loaded
  // ---------------------------------------------------------------
  await t.step('migration through chain with late-loading middle block', () => {
    const G = genesis(h('G'), 5);
    const B = leaf({ hash: h('B'), anchor: h('A'), ownOutputCount: 1 });
    const { provider, module } = setup(G, B);

    const { resolved } = module.addBlock(B.hash, [5]);
    assertEquals(resolved.length, 0);

    assertEquals(getEntries(module, B.hash)?.get(5)?.length, 1);

    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 2 });
    provider.add(A);
    const { resolved: resolvedAfter } = module.onBlockLoaded(A.hash);
    assertEquals(resolvedAfter.length, 1);
    assertEquals(Hash.equals(resolvedAfter[0].block, G.hash), true);
    assertEquals(resolvedAfter[0].outputIndex, 2);

    assertEquals(getEntries(module, B.hash), undefined);
  });

  // ---------------------------------------------------------------
  // Connected component: loading block connects two segments
  // ---------------------------------------------------------------
  await t.step('loading a block connects previously disconnected segments', () => {
    const G = genesis(h('G'), 3);
    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 1 });
    const C = leaf({ hash: h('C'), anchor: h('B'), ownOutputCount: 1 });
    const { provider, module } = setup(G, A, C);

    const { resolved } = module.addBlock(C.hash, [3]);
    assertEquals(resolved.length, 0);

    assertEquals(getEntries(module, C.hash)?.get(3)?.length, 1);

    const B = leaf({ hash: h('B'), anchor: A.hash, ownOutputCount: 1 });
    provider.add(B);
    const { resolved: resolvedAfter } = module.onBlockLoaded(B.hash);
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

    const { resolved } = module.addBlock(C.hash, [0, 2, 4]);
    assertEquals(resolved.length, 3);

    assertEquals(Hash.equals(resolved[0].block, C.hash), true);
    assertEquals(resolved[0].outputIndex, 0);

    assertEquals(Hash.equals(resolved[1].block, G.hash), true);
    assertEquals(resolved[1].outputIndex, 0);

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

    module.addBlock(C.hash, [1]);

    const claimants = module.getClaimantsAt(G.hash, 0);
    assertEquals(claimants?.length, 1);
    assertEquals(Hash.equals(claimants![0].claimant, C.hash), true);
    assertEquals(claimants![0].claimIndex, 0);

    assertEquals(module.getClaimantsAt(G.hash, 1), undefined);
  });

  // ---------------------------------------------------------------
  // Nested aggregation: aggregator of aggregator
  // ---------------------------------------------------------------
  await t.step('nested aggregation migration', () => {
    const G = genesis(h('G'), 10);
    const S1 = leaf({ hash: h('S1'), anchor: G.hash, ownOutputCount: 2 });
    const A1 = aggregator({
      hash: h('A1'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [S1.hash],
      aggregateOutputCounts: [2],
    });

    const A2 = aggregator({
      hash: h('A2'),
      anchor: G.hash,
      ownOutputCount: 1,
      aggregateHashes: [A1.hash],
      aggregateOutputCounts: [3],
    });

    const { module } = setup(G, S1, A1, A2);

    const { resolved } = module.addBlock(A2.hash, [2]);
    assertEquals(resolved.length, 1);
    assertEquals(Hash.equals(resolved[0].block, S1.hash), true);
    assertEquals(resolved[0].outputIndex, 0);
  });
});

// -- Conflict detection tests ------------------------------------

Deno.test('OutputClaimModule: conflict detection', async (t) => {
  await t.step('two blocks claiming same output produces conflict', () => {
    const G = genesis(h('G'), 5);
    const C1 = leaf({ hash: h('C1'), anchor: G.hash, ownOutputCount: 1 });
    const C2 = leaf({ hash: h('C2'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, C1, C2);

    // C1 claims G.out[0] (index 1 in own space: own 1 + G's index 0)
    const r1 = module.addBlock(C1.hash, [1]);
    assertEquals(r1.conflicts.length, 0);

    // C2 also claims G.out[0]
    const r2 = module.addBlock(C2.hash, [1]);
    assertEquals(r2.conflicts.length, 1);
    assertEquals(hasConflictPair(r2.conflicts, C1.hash, C2.hash), true);
  });

  await t.step('two blocks claiming different outputs: no conflict', () => {
    const G = genesis(h('G'), 5);
    const C1 = leaf({ hash: h('C1'), anchor: G.hash, ownOutputCount: 1 });
    const C2 = leaf({ hash: h('C2'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, C1, C2);

    // C1 claims G.out[0], C2 claims G.out[1]
    const r1 = module.addBlock(C1.hash, [1]);
    assertEquals(r1.conflicts.length, 0);

    const r2 = module.addBlock(C2.hash, [2]);
    assertEquals(r2.conflicts.length, 0);
  });

  await t.step('conflict detected via delayed migration (onBlockLoaded)', () => {
    // C1 and C2 both anchor to G and claim G.out[0], but G is not loaded yet.
    const C1 = leaf({ hash: h('C1'), anchor: h('G'), ownOutputCount: 1 });
    const C2 = leaf({ hash: h('C2'), anchor: h('G'), ownOutputCount: 1 });
    const { provider, module } = setup(C1, C2);

    // Both claim index 1 (maps to G.out[0])
    const r1 = module.addBlock(C1.hash, [1]);
    assertEquals(r1.conflicts.length, 0);

    const r2 = module.addBlock(C2.hash, [1]);
    assertEquals(r2.conflicts.length, 0);

    // Now load G -- migration should detect the conflict
    const G = genesis(h('G'), 5);
    provider.add(G);
    const loaded = module.onBlockLoaded(G.hash);
    assertEquals(loaded.conflicts.length, 1);
    assertEquals(hasConflictPair(loaded.conflicts, C1.hash, C2.hash), true);
  });

  await t.step('self-claims never conflict across blocks', () => {
    // C1 and C2 both self-claim their own index 0 -- not a conflict
    const G = genesis(h('G'), 5);
    const C1 = leaf({ hash: h('C1'), anchor: G.hash, ownOutputCount: 2 });
    const C2 = leaf({ hash: h('C2'), anchor: G.hash, ownOutputCount: 2 });
    const { module } = setup(G, C1, C2);

    const r1 = module.addBlock(C1.hash, [0]);
    assertEquals(r1.conflicts.length, 0);

    const r2 = module.addBlock(C2.hash, [0]);
    assertEquals(r2.conflicts.length, 0);
  });

  await t.step('three-way conflict produces all pairs', () => {
    const G = genesis(h('G'), 5);
    const C1 = leaf({ hash: h('C1'), anchor: G.hash, ownOutputCount: 1 });
    const C2 = leaf({ hash: h('C2'), anchor: G.hash, ownOutputCount: 1 });
    const C3 = leaf({ hash: h('C3'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, C1, C2, C3);

    module.addBlock(C1.hash, [1]); // G.out[0]
    const r2 = module.addBlock(C2.hash, [1]); // G.out[0]
    assertEquals(r2.conflicts.length, 1);

    const r3 = module.addBlock(C3.hash, [1]); // G.out[0]
    assertEquals(r3.conflicts.length, 2);
    assertEquals(hasConflictPair(r3.conflicts, C3.hash, C1.hash), true);
    assertEquals(hasConflictPair(r3.conflicts, C3.hash, C2.hash), true);
  });

  await t.step('conflict not re-emitted for known pair', () => {
    const G = genesis(h('G'), 5);
    const C1 = leaf({ hash: h('C1'), anchor: G.hash, ownOutputCount: 1 });
    const C2 = leaf({ hash: h('C2'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, C1, C2);

    // Both claim G.out[0] and G.out[1]
    module.addBlock(C1.hash, [1, 2]);
    const r2 = module.addBlock(C2.hash, [1, 2]);

    // The pair C1<->C2 should only appear once despite two overlapping claims
    assertEquals(r2.conflicts.length, 1);
  });

  await t.step('cross-anchor conflict: blocks at different depths claim same output', () => {
    // G -> A -> B. A claims G.out[0], B also claims G.out[0] via A.
    // But wait -- if A claimed G.out[0], it's gone from A's output space.
    // So B can't claim it via A. Let's use a different setup:
    // A does NOT claim G.out[0]. B (anchoring to A) claims G.out[0].
    // C (anchoring to G directly) also claims G.out[0].
    const G = genesis(h('G'), 5);
    const A = leaf({ hash: h('A'), anchor: G.hash, ownOutputCount: 1 });
    // B anchors to A. B's output space: [B.out0, A.out0, G.out0..4]
    // B claims index 2 = G.out[0]
    const B = leaf({ hash: h('B'), anchor: A.hash, ownOutputCount: 1 });
    // C anchors to G. C's output space: [C.out0, G.out0..4]
    // C claims index 1 = G.out[0]
    const C = leaf({ hash: h('C'), anchor: G.hash, ownOutputCount: 1 });
    const { module } = setup(G, A, B, C);

    module.addBlock(B.hash, [2]); // -> G.out[0]
    const r2 = module.addBlock(C.hash, [1]); // -> G.out[0]
    assertEquals(r2.conflicts.length, 1);
    assertEquals(hasConflictPair(r2.conflicts, B.hash, C.hash), true);
  });
});
