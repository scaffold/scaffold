import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { GarbageCollector } from '../src/node/GarbageCollector.ts';

/** Create a deterministic hash from a numeric seed. */
function hashOf(n: number): Hash {
  return Hash.digest(`block-${n}`);
}

Deno.test('collect() returns empty when under limit', () => {
  const gc = new GarbageCollector({ maxBlocks: 100 });
  for (let i = 0; i < 50; i++) {
    gc.touch(hashOf(i));
  }
  const evicted = gc.collect(50);
  assertEquals(evicted.length, 0);
});

Deno.test('collect() returns empty when exactly at limit', () => {
  const gc = new GarbageCollector({ maxBlocks: 100 });
  for (let i = 0; i < 100; i++) {
    gc.touch(hashOf(i));
  }
  const evicted = gc.collect(100);
  assertEquals(evicted.length, 0);
});

Deno.test('collect() returns oldest non-protected blocks when over limit', () => {
  const gc = new GarbageCollector({ maxBlocks: 10, evictBatch: 3 });
  // Insert blocks 0..14
  for (let i = 0; i < 15; i++) {
    gc.touch(hashOf(i));
  }
  const evicted = gc.collect(15);
  assertEquals(evicted.length, 3);
  // The oldest blocks should be 0, 1, 2 (inserted first)
  assertEquals(evicted[0].toPrimitive(), hashOf(0).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(1).toPrimitive());
  assertEquals(evicted[2].toPrimitive(), hashOf(2).toPrimitive());
});

Deno.test('touch() updates LRU order', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 3 });
  // Insert blocks 0..9
  for (let i = 0; i < 10; i++) {
    gc.touch(hashOf(i));
  }
  // Touch block 0 and 1 to make them recently used
  gc.touch(hashOf(0));
  gc.touch(hashOf(1));

  const evicted = gc.collect(10);
  assertEquals(evicted.length, 3);
  // Blocks 2, 3, 4 should now be the oldest (0 and 1 were re-touched)
  assertEquals(evicted[0].toPrimitive(), hashOf(2).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(3).toPrimitive());
  assertEquals(evicted[2].toPrimitive(), hashOf(4).toPrimitive());
});

Deno.test('recently touched blocks survive collection', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 5 });
  // Insert blocks 0..9
  for (let i = 0; i < 10; i++) {
    gc.touch(hashOf(i));
  }
  // Touch blocks 0..4 to make them most recent
  for (let i = 0; i < 5; i++) {
    gc.touch(hashOf(i));
  }

  const evicted = gc.collect(10);
  assertEquals(evicted.length, 5);
  // Blocks 5..9 should be evicted (they are the oldest now)
  for (let i = 0; i < 5; i++) {
    assertEquals(evicted[i].toPrimitive(), hashOf(i + 5).toPrimitive());
  }
});

Deno.test('protected blocks are never evicted', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 5 });
  // Insert blocks 0..9
  for (let i = 0; i < 10; i++) {
    gc.touch(hashOf(i));
  }
  // Protect the oldest blocks (0, 1, 2)
  gc.addProtected(hashOf(0));
  gc.addProtected(hashOf(1));
  gc.addProtected(hashOf(2));

  const evicted = gc.collect(10);
  assertEquals(evicted.length, 5);
  // Should skip 0, 1, 2 and evict 3, 4, 5, 6, 7
  assertEquals(evicted[0].toPrimitive(), hashOf(3).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(4).toPrimitive());
  assertEquals(evicted[2].toPrimitive(), hashOf(5).toPrimitive());
  assertEquals(evicted[3].toPrimitive(), hashOf(6).toPrimitive());
  assertEquals(evicted[4].toPrimitive(), hashOf(7).toPrimitive());
});

Deno.test('removeProtected allows block to be evicted', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 2 });
  for (let i = 0; i < 10; i++) {
    gc.touch(hashOf(i));
  }
  // Protect block 0, then unprotect it
  gc.addProtected(hashOf(0));
  gc.removeProtected(hashOf(0));

  const evicted = gc.collect(10);
  assertEquals(evicted.length, 2);
  // Block 0 should be evictable again (oldest)
  assertEquals(evicted[0].toPrimitive(), hashOf(0).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(1).toPrimitive());
});

Deno.test('evictBatch defaults to 10% of maxBlocks, minimum 1', () => {
  // 10% of 100 = 10
  const gc100 = new GarbageCollector({ maxBlocks: 100 });
  for (let i = 0; i < 120; i++) {
    gc100.touch(hashOf(i));
  }
  const evicted100 = gc100.collect(120);
  assertEquals(evicted100.length, 10);

  // 10% of 5 = 0.5, floored to 0, but minimum is 1
  const gc5 = new GarbageCollector({ maxBlocks: 5 });
  for (let i = 0; i < 10; i++) {
    gc5.touch(hashOf(i));
  }
  const evicted5 = gc5.collect(10);
  assertEquals(evicted5.length, 1);

  // 10% of 1 = 0.1, floored to 0, but minimum is 1
  const gc1 = new GarbageCollector({ maxBlocks: 1 });
  gc1.touch(hashOf(0));
  gc1.touch(hashOf(1));
  const evicted1 = gc1.collect(2);
  assertEquals(evicted1.length, 1);
});

Deno.test('forget() removes from tracking', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 3 });
  for (let i = 0; i < 10; i++) {
    gc.touch(hashOf(i));
  }
  // Forget block 0 (the oldest)
  gc.forget(hashOf(0));

  const evicted = gc.collect(10);
  assertEquals(evicted.length, 3);
  // Block 0 is forgotten, so oldest is now 1, 2, 3
  assertEquals(evicted[0].toPrimitive(), hashOf(1).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(2).toPrimitive());
  assertEquals(evicted[2].toPrimitive(), hashOf(3).toPrimitive());
});

Deno.test('forget() also removes from protected set', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 2 });
  for (let i = 0; i < 10; i++) {
    gc.touch(hashOf(i));
  }
  gc.addProtected(hashOf(0));
  // Forget removes from both LRU and protected
  gc.forget(hashOf(0));

  const evicted = gc.collect(10);
  assertEquals(evicted.length, 2);
  // Block 0 is gone, block 1 is oldest
  assertEquals(evicted[0].toPrimitive(), hashOf(1).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(2).toPrimitive());
});

Deno.test('collect() does not evict more than available unprotected blocks', () => {
  const gc = new GarbageCollector({ maxBlocks: 5, evictBatch: 10 });
  for (let i = 0; i < 8; i++) {
    gc.touch(hashOf(i));
  }
  // Protect most blocks, leaving only 2 unprotected
  for (let i = 2; i < 8; i++) {
    gc.addProtected(hashOf(i));
  }

  const evicted = gc.collect(8);
  assertEquals(evicted.length, 2);
  assertEquals(evicted[0].toPrimitive(), hashOf(0).toPrimitive());
  assertEquals(evicted[1].toPrimitive(), hashOf(1).toPrimitive());
});
