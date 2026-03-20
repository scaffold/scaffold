import { assert, assertEquals, assertFalse } from '@std/assert';
import { BitVector } from '../src/core/BitVector.ts';

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
  // Output 5 was claimed by chain -- removed, conflict
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
  // After chain claims {1,3}: output 2 -> surviving idx 1
  // Original indices remaining: 0,2,4,5,6,7,8,9
  // Output 2 -> surviving index 1 -> + 2 prepended = 3
  // Output 7 -> surviving index 5 -> + 2 prepended = 7
  assert(result.rebased.get(3));
  assert(result.rebased.get(7));
  assertEquals(result.rebased.popcount(), 2);
});
