import { assertEquals } from '@std/assert';
import { setPut, setsIntersect } from '../../src/util/set.ts';
import { range } from '../../src/util/functional.ts';

class CountingSet<T> extends Set<T> {
  hasCalls = 0;
  override has(val: T) {
    this.hasCalls++;
    return super.has(val);
  }
}

Deno.test('setsIntersect: empty sets never intersect', () => {
  assertEquals(setsIntersect(new Set(), new Set()), false);
  assertEquals(setsIntersect(new Set([1]), new Set()), false);
  assertEquals(setsIntersect(new Set(), new Set([1])), false);
});

Deno.test('setsIntersect: disjoint sets do not intersect', () => {
  assertEquals(setsIntersect(new Set([1, 2, 3]), new Set([4, 5])), false);
});

Deno.test('setsIntersect: a subset intersects in both argument orders', () => {
  const big = new Set([1, 2, 3, 4]);
  const small = new Set([3]);
  assertEquals(setsIntersect(big, small), true);
  assertEquals(setsIntersect(small, big), true);
});

Deno.test('setsIntersect: identical sets intersect', () => {
  const s = new Set([1, 2]);
  assertEquals(setsIntersect(s, s), true);
});

Deno.test('setsIntersect: uses reference identity, not structural equality', () => {
  assertEquals(setsIntersect(new Set([{ a: 1 }]), new Set([{ a: 1 }])), false);
});

Deno.test('setsIntersect: iterates the smaller set whichever way it is passed', () => {
  const small = new CountingSet([-1, -2]);
  const big = new CountingSet(range(100));
  small.hasCalls = 0;
  big.hasCalls = 0;

  setsIntersect(small, big);
  assertEquals(small.hasCalls, 0);
  assertEquals(big.hasCalls, 2);

  big.hasCalls = 0;
  setsIntersect(big, small);
  assertEquals(small.hasCalls, 0);
  assertEquals(big.hasCalls, 2);
});

Deno.test('setPut: reports whether the value was new', () => {
  const s = new Set<number>();
  assertEquals(setPut(s, 1), true);
  assertEquals(setPut(s, 1), false);
  assertEquals([...s], [1]);
});
