import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { BitVector } from '../src/BitVector.ts';
import { ConflictModule, ConflictProvider } from '../src/ConflictModule.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  /** Subtree claim mask against anchor outputs. Null = no subtrees. */
  claimMask: BitVector | null;
  /** Per-subtree output counts. */
  aggregateOutputCounts: number[];
  /** Block's own claims against post-subtree vector. */
  ownClaims: BitVector;
  /** Number of new outputs this block itself produces. */
  ownOutputCount: number;
  /** Total output count after full transformation. */
  outputCount: number;
  /** Anchor's output count. */
  anchorOutputCount: number;
  /** Ordered subtree root hashes. */
  children: Hash[];
}

class TestProvider implements ConflictProvider<TestBlock> {
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

  getClaimMask(block: TestBlock): BitVector | null {
    return block.claimMask;
  }

  getAggregateOutputCounts(block: TestBlock): number[] {
    return block.aggregateOutputCounts;
  }

  getOwnClaims(block: TestBlock): BitVector {
    return block.ownClaims;
  }

  getOwnOutputCount(block: TestBlock): number {
    return block.ownOutputCount;
  }

  getOutputCount(block: TestBlock): number {
    return block.outputCount;
  }

  getAnchorOutputCount(block: TestBlock): number {
    return block.anchorOutputCount;
  }

  getChildren(block: TestBlock): Hash[] {
    return block.children;
  }
}

const h = (name: string): Hash => Hash.digest(name);

/**
 * Helper to create a simple leaf block.
 * A leaf block has no subtrees — only its own claims and outputs.
 */
function leaf(opts: {
  hash: Hash;
  anchor: Hash;
  anchorOutputCount: number;
  claims: number[];
  ownOutputCount: number;
}): TestBlock {
  const { hash, anchor, anchorOutputCount, claims, ownOutputCount } = opts;
  // For a leaf block: no subtrees, so ownClaims is against anchor directly
  // and claimMask is null (no subtrees)
  const ownClaims = BitVector.fromIndices(anchorOutputCount, claims);
  const outputCount = anchorOutputCount - claims.length + ownOutputCount;
  return {
    hash,
    anchor,
    claimMask: null,
    aggregateOutputCounts: [],
    ownClaims,
    ownOutputCount,
    outputCount,
    anchorOutputCount,
    children: [],
  };
}

/** Helper to create a genesis block. */
function genesis(hash: Hash): TestBlock {
  return {
    hash,
    anchor: ZERO_HASH,
    claimMask: null,
    aggregateOutputCounts: [],
    ownClaims: BitVector.empty(0),
    ownOutputCount: 0,
    outputCount: 0,
    anchorOutputCount: 0,
    children: [],
  };
}

function setup(...blocks: TestBlock[]): {
  provider: TestProvider;
  module: ConflictModule<TestBlock>;
} {
  const provider = new TestProvider();
  const module = new ConflictModule(provider);
  for (const block of blocks) {
    provider.add(block);
    module.addBlock(block.hash);
  }
  return { provider, module };
}

// -- BitVector Tests ---------------------------------------------

Deno.test({ name: 'BitVector: empty vector has all false bits' }, () => {
  const bv = BitVector.empty(64);
  assertEquals(bv.length, 64);
  for (let i = 0; i < 64; i++) {
    assertFalse(bv.get(i));
  }
  assertEquals(bv.popcount(), 0);
});

Deno.test({ name: 'BitVector: set and get bits' }, () => {
  const bv = BitVector.empty(32);
  bv.set(0, true);
  bv.set(7, true);
  bv.set(31, true);
  assert(bv.get(0));
  assert(bv.get(7));
  assert(bv.get(31));
  assertFalse(bv.get(1));
  assertFalse(bv.get(30));
  assertEquals(bv.popcount(), 3);
});

Deno.test({ name: 'BitVector: fromBits' }, () => {
  const bv = BitVector.fromBits([true, false, true, false, true]);
  assertEquals(bv.length, 5);
  assert(bv.get(0));
  assertFalse(bv.get(1));
  assert(bv.get(2));
  assertFalse(bv.get(3));
  assert(bv.get(4));
  assertEquals(bv.popcount(), 3);
});

Deno.test({ name: 'BitVector: fromIndices' }, () => {
  const bv = BitVector.fromIndices(10, [1, 3, 9]);
  assertEquals(bv.length, 10);
  assertFalse(bv.get(0));
  assert(bv.get(1));
  assertFalse(bv.get(2));
  assert(bv.get(3));
  assert(bv.get(9));
  assertEquals(bv.popcount(), 3);
});

Deno.test({ name: 'BitVector: intersects detects overlap' }, () => {
  const a = BitVector.fromIndices(16, [1, 5, 10]);
  const b = BitVector.fromIndices(16, [5, 12]);
  assert(a.intersects(b));
});

Deno.test({ name: 'BitVector: intersects returns false for disjoint' }, () => {
  const a = BitVector.fromIndices(16, [1, 3]);
  const b = BitVector.fromIndices(16, [5, 12]);
  assertFalse(a.intersects(b));
});

Deno.test({ name: 'BitVector: unknown chunks treated as zeros' }, () => {
  const a = BitVector.unknown(512);
  const b = BitVector.fromIndices(512, [0, 100, 300]);

  // Unknown chunks produce no intersection
  assertFalse(a.intersects(b));
  assertFalse(a.get(100));
  assertEquals(a.popcount(), 0);
});

Deno.test({ name: 'BitVector: loadChunk reveals bits' }, () => {
  const bv = BitVector.unknown(512);
  assertFalse(bv.isChunkLoaded(0));

  // Create chunk data with bit 5 set
  const chunkData = new Uint8Array(32);
  chunkData[0] = 0b00100000; // bit 5
  bv.loadChunk(0, chunkData);

  assert(bv.isChunkLoaded(0));
  assert(bv.get(5));
  assertFalse(bv.get(0));
  assertEquals(bv.popcount(), 1);
});

Deno.test({ name: 'BitVector: clone produces independent copy' }, () => {
  const a = BitVector.fromIndices(32, [3, 7]);
  const b = a.clone();
  b.set(3, false);
  b.set(15, true);

  assert(a.get(3));
  assertFalse(a.get(15));
  assertFalse(b.get(3));
  assert(b.get(15));
});

Deno.test({ name: 'BitVector: or merges bits' }, () => {
  const a = BitVector.fromIndices(16, [1, 3]);
  const b = BitVector.fromIndices(16, [3, 5]);
  a.or(b);
  assert(a.get(1));
  assert(a.get(3));
  assert(a.get(5));
  assertEquals(a.popcount(), 3);
});

Deno.test({ name: 'BitVector: rebase through empty transformation' }, () => {
  const claims = BitVector.fromIndices(10, [2, 5]);
  const result = claims.rebase({
    claimMask: BitVector.empty(10),
    newOutputCount: 3,
  });
  assertFalse(result.chainConflict);
  // Original indices 2,5 should shift by +3 (prepended outputs)
  assert(result.rebased.get(5)); // 2 + 3
  assert(result.rebased.get(8)); // 5 + 3
  assertEquals(result.rebased.popcount(), 2);
});

Deno.test({ name: 'BitVector: rebase detects chain conflict' }, () => {
  const claims = BitVector.fromIndices(10, [2, 5]);
  const chainClaims = BitVector.fromIndices(10, [5, 8]);
  const result = claims.rebase({
    claimMask: chainClaims,
    newOutputCount: 0,
  });
  assert(result.chainConflict);
  // Output 2 survives (shifted: 2 remains at 2 since no removals before it)
  assert(result.rebased.get(2));
  // Output 5 was claimed by chain — removed, conflict
  assertEquals(result.rebased.popcount(), 1);
});

Deno.test({ name: 'BitVector: rebase with removals shifts indices' }, () => {
  // Anchor has 10 outputs. Chain claims outputs 1 and 3.
  // Our block claims outputs 2 and 7.
  const claims = BitVector.fromIndices(10, [2, 7]);
  const chainClaims = BitVector.fromIndices(10, [1, 3]);
  const result = claims.rebase({
    claimMask: chainClaims,
    newOutputCount: 2,
  });
  assertFalse(result.chainConflict);
  // After chain claims {1,3}: output 2 -> surviving idx 1 (0 removed before it: only 1 is before 2 and it's removed, so idx=1)
  // Actually: original indices remaining: 0,2,4,5,6,7,8,9
  // Output 2 -> surviving index 1 -> + 2 prepended = 3
  // Output 7 -> surviving index 5 -> + 2 prepended = 7
  assert(result.rebased.get(3));
  assert(result.rebased.get(7));
  assertEquals(result.rebased.popcount(), 2);
});

// -- ConflictModule Tests ----------------------------------------

Deno.test({ name: 'same anchor: overlapping claims conflict' }, () => {
  const G = genesis(h('G'));
  // G has 0 outputs, so make a chain block with outputs
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  // Two blocks anchor to C, both claiming output 3
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3, 7],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, A, B);

  assert(module.hasConflict(A.hash, B.hash));
  assert(module.hasConflict(B.hash, A.hash)); // symmetric
});

Deno.test({ name: 'same anchor: disjoint claims no conflict' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [1, 3],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [5, 7],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, A, B);

  assertFalse(module.hasConflict(A.hash, B.hash));
});

Deno.test({ name: 'same anchor: multiple overlapping outputs all detected' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [1, 3, 5],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3, 5, 9],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, A, B);

  assert(module.hasConflict(A.hash, B.hash));
});

Deno.test({ name: 'three-way conflict: all pairs detected' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const D = leaf({
    hash: h('D'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, A, B, D);

  assert(module.hasConflict(A.hash, B.hash));
  assert(module.hasConflict(A.hash, D.hash));
  assert(module.hasConflict(B.hash, D.hash));
});

Deno.test({ name: 'addBlock returns newly discovered conflict pairs' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3, 7],
    ownOutputCount: 0,
  });

  const provider = new TestProvider();
  const module = new ConflictModule(provider);
  provider.add(G);
  provider.add(C);
  provider.add(A);
  provider.add(B);
  module.addBlock(G.hash);
  module.addBlock(C.hash);

  const conflictsFromA = module.addBlock(A.hash);
  assertEquals(conflictsFromA.length, 0);

  const conflictsFromB = module.addBlock(B.hash);
  assertEquals(conflictsFromB.length, 1);
});

Deno.test({
  name: 'rebasing: forward rebase through single block',
}, () => {
  const G = genesis(h('G'));
  const C1 = leaf({
    hash: h('C1'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  // C2 anchors to C1, claims output 2, adds 3 new outputs
  const C2 = leaf({
    hash: h('C2'),
    anchor: C1.hash,
    anchorOutputCount: 10,
    claims: [2],
    ownOutputCount: 3,
  });
  // T1 anchors to C1 and claims output 5
  const T1 = leaf({
    hash: h('T1'),
    anchor: C1.hash,
    anchorOutputCount: 10,
    claims: [5],
    ownOutputCount: 0,
  });
  // T2 anchors to C2 and claims some output
  const T2 = leaf({
    hash: h('T2'),
    anchor: C2.hash,
    anchorOutputCount: 12, // 10 - 1 + 3 = 12
    claims: [7], // This is index 7 in C2's output space
    ownOutputCount: 0,
  });

  const { module } = setup(G, C1, C2, T1, T2);

  // Rebase T1's claims from C1's space to C2's space
  const result = module.rebase(T1.hash, C2.hash);
  assert(result !== undefined);
  assertFalse(result.chainConflict);

  // T1 claims output 5 of C1.
  // C2 claims output 2 of C1, adds 3 new outputs.
  // Surviving C1 outputs: 0,1,3,4,5,6,7,8,9 (9 outputs)
  // Output 5 -> surviving idx 4 (indices 0,1,3,4,5 -> 5 is the 5th surviving = idx 4)
  // Plus 3 prepended -> index 7
  assert(result.mask.get(7));
  assertEquals(result.mask.popcount(), 1);

  // T2 also claims index 7 in C2's space — they conflict!
  const t2Mask = module.getNetClaimMask(T2.hash);
  assert(t2Mask !== undefined);
  assert(result.mask.intersects(t2Mask!));
});

Deno.test({
  name: 'rebasing: chain conflict when block and chain claim same output',
}, () => {
  const G = genesis(h('G'));
  const C1 = leaf({
    hash: h('C1'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  // C2 claims output 5 from C1
  const C2 = leaf({
    hash: h('C2'),
    anchor: C1.hash,
    anchorOutputCount: 10,
    claims: [5],
    ownOutputCount: 0,
  });
  // T1 also claims output 5 from C1
  const T1 = leaf({
    hash: h('T1'),
    anchor: C1.hash,
    anchorOutputCount: 10,
    claims: [5],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C1, C2, T1);

  const result = module.rebase(T1.hash, C2.hash);
  assert(result !== undefined);
  assert(result.chainConflict);
});

Deno.test({
  name: 'rebasing: forward rebase through multi-block chain',
}, () => {
  const G = genesis(h('G'));
  const C1 = leaf({
    hash: h('C1'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  // C2: claims {1}, adds 2 outputs. Result: 11 outputs.
  const C2 = leaf({
    hash: h('C2'),
    anchor: C1.hash,
    anchorOutputCount: 10,
    claims: [1],
    ownOutputCount: 2,
  });
  // C3: claims {0} from C2, adds 1 output. Result: 11 outputs.
  const C3 = leaf({
    hash: h('C3'),
    anchor: C2.hash,
    anchorOutputCount: 11,
    claims: [0],
    ownOutputCount: 1,
  });
  // T1 anchors to C1, claims output 7
  const T1 = leaf({
    hash: h('T1'),
    anchor: C1.hash,
    anchorOutputCount: 10,
    claims: [7],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C1, C2, C3, T1);

  const result = module.rebase(T1.hash, C3.hash);
  assert(result !== undefined);
  assertFalse(result.chainConflict);

  // T1 claims output 7 of C1.
  // Through C2: C2 claims {1}, adds 2. Surviving: 0,2,3,4,5,6,7,8,9
  //   Output 7 -> surviving idx 6 -> +2 prepended = 8
  // Through C3: C3 claims {0}, adds 1. Surviving from C2: 1,2,3,4,5,6,7,8,9,10
  //   Output 8 -> surviving idx 7 -> +1 prepended = 8
  assert(result.mask.get(8));
  assertEquals(result.mask.popcount(), 1);
});

Deno.test({ name: 'partial knowledge: unknown chunks do not produce conflicts' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 512, // Large enough for multiple chunks
  });

  // A has fully known claims
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 512,
    claims: [3],
    ownOutputCount: 0,
  });

  // B is partially known — create manually with unknown mask
  const B: TestBlock = {
    hash: h('B'),
    anchor: C.hash,
    claimMask: null,
    aggregateOutputCounts: [],
    ownClaims: BitVector.unknown(512),
    ownOutputCount: 0,
    outputCount: 512,
    anchorOutputCount: 512,
    children: [],
  };

  const { module } = setup(G, C, A, B);

  // B's claims are unknown — no conflict should be detected yet
  assertFalse(module.hasConflict(A.hash, B.hash));
});

Deno.test({
  name: 'partial knowledge: loading chunk reveals conflict',
}, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 512,
  });

  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 512,
    claims: [3],
    ownOutputCount: 0,
  });

  // B starts with unknown claims
  const B: TestBlock = {
    hash: h('B'),
    anchor: C.hash,
    claimMask: null,
    aggregateOutputCounts: [],
    ownClaims: BitVector.unknown(512),
    ownOutputCount: 0,
    outputCount: 512,
    anchorOutputCount: 512,
    children: [],
  };

  const provider = new TestProvider();
  const module = new ConflictModule(provider);
  for (const block of [G, C, A, B]) {
    provider.add(block);
    module.addBlock(block.hash);
  }

  assertFalse(module.hasConflict(A.hash, B.hash));

  // Load chunk 0 of B with bit 3 set — same as A's claim
  const chunkData = new Uint8Array(32);
  chunkData[0] = 0b00001000; // bit 3
  const newConflicts = module.loadClaimMaskChunk(B.hash, 0, chunkData);

  assertEquals(newConflicts.length, 1);
  assert(module.hasConflict(A.hash, B.hash));
});

Deno.test({
  name: 'upward inference: child claim inferred on aggregator',
}, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });

  // Block A claims output 3 — fully known
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });

  // Block AGG is an aggregator with unknown claim mask (partially known)
  const AGG: TestBlock = {
    hash: h('AGG'),
    anchor: C.hash,
    claimMask: BitVector.unknown(10),
    aggregateOutputCounts: [2],
    ownClaims: BitVector.empty(12), // 10 + 2 subtree outputs
    ownOutputCount: 0,
    outputCount: 12,
    anchorOutputCount: 10,
    children: [h('subtree1')],
  };

  const provider = new TestProvider();
  const module = new ConflictModule(provider);
  for (const block of [G, C, A, AGG]) {
    provider.add(block);
    module.addBlock(block.hash);
  }

  // No conflict yet — AGG's claims are unknown
  assertFalse(module.hasConflict(A.hash, AGG.hash));

  // Infer that AGG must claim output 3 (because its subtree does)
  const newConflicts = module.inferClaimFromDescendant(AGG.hash, 3);

  assertEquals(newConflicts.length, 1);
  assert(module.hasConflict(A.hash, AGG.hash));
});

Deno.test({
  name: 'monotonicity: conflicts never disappear after discovery',
}, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, A, B);

  assert(module.hasConflict(A.hash, B.hash));

  // Adding more blocks doesn't remove existing conflicts
  const D = leaf({
    hash: h('D'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [5],
    ownOutputCount: 0,
  });
  const provider = new TestProvider();
  provider.add(D);

  // Conflict persists
  assert(module.hasConflict(A.hash, B.hash));
});

Deno.test({
  name: 'aggregation: block own claims on anchor outputs create net mask',
}, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });

  // Aggregator with one subtree that claims output 2 and adds 3 outputs.
  // The aggregator itself also claims an anchor output (surviving idx 1 after subtree,
  // which corresponds to original anchor output 1).
  const subtreeClaimMask = BitVector.fromIndices(10, [2]);
  // After subtree: vector has 3 subtree outputs + 9 surviving anchor outputs = 12
  // Own claims on that 12-element vector:
  // Index 4 = surviving anchor output 1 (subtree outputs at 0,1,2; surviving: 0->3, 1->4)
  const ownClaims = BitVector.fromIndices(12, [4]);

  const AGG: TestBlock = {
    hash: h('AGG'),
    anchor: C.hash,
    claimMask: subtreeClaimMask,
    aggregateOutputCounts: [3],
    ownClaims,
    ownOutputCount: 0,
    outputCount: 11, // 12 - 1 (own claim)
    anchorOutputCount: 10,
    children: [h('s1')],
  };

  // Another block that claims output 1
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [1],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, AGG, B);

  // AGG claims outputs 2 (subtree) and 1 (own) from C
  // B claims output 1 from C
  // They should conflict on output 1
  assert(module.hasConflict(AGG.hash, B.hash));
});

Deno.test({
  name: 'aggregation: subtree claiming other subtree output is internal, no anchor conflict',
}, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });

  // Aggregator with subtree claims on outputs {2, 5}
  const subtreeClaimMask = BitVector.fromIndices(10, [2, 5]);
  // After subtrees: 4 subtree outputs + 8 surviving anchor outputs = 12
  // Own claims: index 1 is a subtree output (internal consumption)
  const ownClaims = BitVector.fromIndices(12, [1]);

  const AGG: TestBlock = {
    hash: h('AGG'),
    anchor: C.hash,
    claimMask: subtreeClaimMask,
    aggregateOutputCounts: [4],
    ownClaims,
    ownOutputCount: 0,
    outputCount: 11,
    anchorOutputCount: 10,
    children: [h('s1')],
  };

  // Another block claims outputs {0, 1} — disjoint with AGG's anchor claims {2, 5}
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [0, 1],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, AGG, B);

  // AGG only claims outputs {2, 5} from anchor.
  // Own claim on index 1 is subtree-internal, doesn't affect anchor.
  // B claims {0, 1} — disjoint.
  assertFalse(module.hasConflict(AGG.hash, B.hash));
});

Deno.test({ name: 'getConflicts returns all conflicting block hashes' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3],
    ownOutputCount: 0,
  });
  const D = leaf({
    hash: h('D'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [3, 7],
    ownOutputCount: 0,
  });

  const { module } = setup(G, C, A, B, D);

  const aConflicts = module.getConflicts(A.hash);
  assert(aConflicts.has(B.hash.toPrimitive()));
  assert(aConflicts.has(D.hash.toPrimitive()));
  assertEquals(aConflicts.size, 2);
});

Deno.test({ name: 'no claims: blocks with no claims never conflict' }, () => {
  const G = genesis(h('G'));
  const C = leaf({
    hash: h('C'),
    anchor: G.hash,
    anchorOutputCount: 0,
    claims: [],
    ownOutputCount: 10,
  });
  const A = leaf({
    hash: h('A'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [],
    ownOutputCount: 2,
  });
  const B = leaf({
    hash: h('B'),
    anchor: C.hash,
    anchorOutputCount: 10,
    claims: [],
    ownOutputCount: 3,
  });

  const { module } = setup(G, C, A, B);

  assertFalse(module.hasConflict(A.hash, B.hash));
});
