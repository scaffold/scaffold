import { assertEquals, AssertionError, assertStrictEquals, assertThrows } from '@std/assert';
import {
  getOrCreate,
  mapDec,
  mapInc,
  mapPop,
  mapPut,
  MapSpec,
  multimapCall,
  multimapPop,
  multimapPut,
} from '../../src/util/map.ts';
import { setPut, setsIntersect } from '../../src/util/set.ts';
import { arrCall, arrRemove } from '../../src/util/array.ts';
import { error, mapEntries, mapOne, match, memoize, range } from '../../src/util/functional.ts';

// -- map.ts: mapPut --

Deno.test('mapPut: creates a missing entry and stores it', () => {
  const m = new Map<string, number>();
  assertEquals(mapPut(m, 'a', () => 1), 1);
  assertEquals(m.get('a'), 1);
});

Deno.test('mapPut: returns the existing entry without invoking the creator', () => {
  const m = new Map<string, number>([['a', 1]]);
  let calls = 0;
  assertEquals(mapPut(m, 'a', () => (calls++, 2)), 1);
  assertEquals(calls, 0);
});

Deno.test('mapPut: the mutator replaces an existing entry', () => {
  const m = new Map<string, number>([['a', 1]]);
  assertEquals(mapPut(m, 'a', () => 100, (x) => x + 10), 11);
  assertEquals(m.get('a'), 11);
});

Deno.test('mapPut: the mutator is skipped on first insert', () => {
  const m = new Map<string, number>();
  let mutated = 0;
  assertEquals(mapPut(m, 'a', () => 1, (x) => (mutated++, x + 10)), 1);
  assertEquals(mutated, 0);
});

Deno.test('mapPut: accepts any MapSpec, not just Map', () => {
  const backing: Record<string, number | undefined> = {};
  const spec: MapSpec<string, number> = {
    get: (k) => backing[k],
    set: (k, v) => void (backing[k] = v),
    delete: (k) => delete backing[k],
  };
  assertEquals(mapPut(spec, 'a', () => 3), 3);
  assertEquals(backing.a, 3);
});

Deno.test('mapPut: a reentrant creator on the same key throws', () => {
  const m = new Map<string, number>();
  assertThrows(
    () => mapPut(m, 'a', () => mapPut(m, 'a', () => 1)),
    Error,
    'mapPut called recursively!',
  );
});

Deno.test('mapPut: the recursion sentinel does not outlive the failed call', () => {
  const m = new Map<string, number>();
  assertThrows(() => mapPut(m, 'a', () => mapPut(m, 'a', () => 1)));
  assertEquals(m.has('a'), false);
  assertEquals(mapPut(m, 'a', () => 7), 7);
  assertEquals(m.get('a'), 7);
});

Deno.test('mapPut: a reentrant mutator on the same key throws and leaves no sentinel', () => {
  const m = new Map<string, number>([['a', 1]]);
  assertThrows(
    () => mapPut(m, 'a', () => 0, () => mapPut(m, 'a', () => 0, (x) => x)),
    Error,
    'mapPut called recursively!',
  );
  assertEquals(m.has('a'), false);
});

Deno.test('mapPut: recursion into a different key is allowed', () => {
  const m = new Map<string, number>();
  assertEquals(mapPut(m, 'a', () => mapPut(m, 'b', () => 2) + 1), 3);
  assertEquals(m.get('a'), 3);
  assertEquals(m.get('b'), 2);
});

Deno.test('mapPut: a throwing creator leaves the key absent', () => {
  const m = new Map<string, number>();
  assertThrows(() => mapPut(m, 'a', () => error('boom')), Error, 'boom');
  assertEquals(m.has('a'), false);
});

Deno.test('mapPut: a throwing mutator drops the previous value', () => {
  // The sentinel swap deletes the key before the mutator runs, so a mutator
  // that throws destroys the entry it was meant to update.
  const m = new Map<string, number>([['a', 1]]);
  assertThrows(() => mapPut(m, 'a', () => 0, () => error('boom')), Error, 'boom');
  assertEquals(m.has('a'), false);
});

Deno.test('mapPut: a stored undefined is indistinguishable from absent', () => {
  const m = new Map<string, number | undefined>([['a', undefined]]);
  let calls = 0;
  assertEquals(mapPut(m, 'a', () => (calls++, 5)), 5);
  assertEquals(calls, 1);
});

Deno.test('mapPut: a creator returning undefined is never cached', () => {
  const m = new Map<string, undefined>();
  let calls = 0;
  mapPut(m, 'a', () => (calls++, undefined));
  mapPut(m, 'a', () => (calls++, undefined));
  assertEquals(calls, 2);
  assertEquals(m.has('a'), true);
});

Deno.test('getOrCreate: is mapPut', () => {
  assertStrictEquals(getOrCreate, mapPut);
});

// -- map.ts: mapPop --

Deno.test('mapPop: removes and returns the value', () => {
  const m = new Map<string, number>([['a', 1]]);
  assertEquals(mapPop(m, 'a'), 1);
  assertEquals(m.has('a'), false);
});

Deno.test('mapPop: a missing key yields undefined and no mutation', () => {
  const m = new Map<string, number>([['a', 1]]);
  assertEquals(mapPop(m, 'b'), undefined);
  assertEquals(m.size, 1);
});

// -- map.ts: mapInc / mapDec --

Deno.test('mapInc: counts up from one', () => {
  const m = new Map<string, number>();
  assertEquals(mapInc(m, 'a'), 1);
  assertEquals(mapInc(m, 'a'), 2);
  assertEquals(mapInc(m, 'a'), 3);
  assertEquals(m.get('a'), 3);
});

Deno.test('mapDec: counts down and keeps the key above zero', () => {
  const m = new Map<string, number>([['a', 3]]);
  assertEquals(mapDec(m, 'a'), 2);
  assertEquals(mapDec(m, 'a'), 1);
  assertEquals(m.get('a'), 1);
});

Deno.test('mapDec: reaching zero deletes the key', () => {
  const m = new Map<string, number>([['a', 1]]);
  assertEquals(mapDec(m, 'a'), 0);
  assertEquals(m.has('a'), false);
});

Deno.test('mapDec: a missing key throws', () => {
  const m = new Map<string, number>();
  assertThrows(() => mapDec(m, 'a'), Error, 'Cannot decrement key a; already zero!');
});

Deno.test('mapDec: an explicitly stored zero goes negative rather than throwing', () => {
  // `?? error(...)` only fires on nullish, so a stored 0 slips past the guard
  // its own message describes. Unreachable while mapDec owns every write.
  const m = new Map<string, number>([['a', 0]]);
  assertEquals(mapDec(m, 'a'), -1);
  assertEquals(m.get('a'), -1);
});

Deno.test('mapInc and mapDec round trip', () => {
  const m = new Map<string, number>();
  mapInc(m, 'a');
  mapInc(m, 'a');
  mapDec(m, 'a');
  mapDec(m, 'a');
  assertEquals(m.size, 0);
});

// -- map.ts: multimap --

Deno.test('multimapPut: creates the bucket and appends in order', () => {
  const m = new Map<string, number[]>();
  multimapPut(m, 'a', 1);
  multimapPut(m, 'a', 2);
  multimapPut(m, 'b', 3);
  assertEquals(m.get('a'), [1, 2]);
  assertEquals(m.get('b'), [3]);
});

Deno.test('multimapPop: removes one entry and keeps the bucket', () => {
  const m = new Map<string, number[]>();
  multimapPut(m, 'a', 1);
  multimapPut(m, 'a', 2);
  multimapPop(m, 'a', 1);
  assertEquals(m.get('a'), [2]);
});

Deno.test('multimapPop: popping the last entry deletes the key', () => {
  const m = new Map<string, number[]>();
  multimapPut(m, 'a', 1);
  multimapPop(m, 'a', 1);
  assertEquals(m.has('a'), false);
});

Deno.test('multimapPop: removes the last occurrence of a duplicate', () => {
  const m = new Map<string, string[]>();
  const dup = 'x';
  multimapPut(m, 'a', dup);
  multimapPut(m, 'a', 'y');
  multimapPut(m, 'a', dup);
  multimapPop(m, 'a', dup);
  assertEquals(m.get('a'), [dup, 'y']);
});

Deno.test('multimapPop: a missing key throws', () => {
  const m = new Map<string, number[]>();
  assertThrows(() => multimapPop(m, 'a', 1), Error, 'Cannot pop - key does not exist: a');
});

Deno.test('multimapPop: a missing value throws and leaves the bucket intact', () => {
  const m = new Map<string, number[]>();
  multimapPut(m, 'a', 1);
  assertThrows(() => multimapPop(m, 'a', 2), Error, 'Cannot pop - value does not exist!');
  assertEquals(m.get('a'), [1]);
});

Deno.test('multimapCall: invokes every callback in order with the args', () => {
  const m = new Map<string, ((a: number, b: string) => void)[]>();
  const seen: string[] = [];
  multimapPut(m, 'k', (a, b) => void seen.push(`1:${a}${b}`));
  multimapPut(m, 'k', (a, b) => void seen.push(`2:${a}${b}`));
  multimapCall(m, 'k', 7, 'x');
  assertEquals(seen, ['1:7x', '2:7x']);
});

Deno.test('multimapCall: a missing key is a no-op', () => {
  const m = new Map<string, (() => void)[]>();
  multimapCall(m, 'k');
});

Deno.test('multimapCall: a callback that unsubscribes itself skips the next one', () => {
  // Array iteration is index-based, so splicing during dispatch shifts the tail.
  const m = new Map<string, (() => void)[]>();
  const seen: number[] = [];
  const first = () => {
    seen.push(1);
    multimapPop(m, 'k', first);
  };
  multimapPut(m, 'k', first);
  multimapPut(m, 'k', () => void seen.push(2));
  multimapPut(m, 'k', () => void seen.push(3));
  multimapCall(m, 'k');
  assertEquals(seen, [1, 3]);
});

// -- set.ts --

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

// -- array.ts --

Deno.test('arrCall: invokes every callback with the args', () => {
  const seen: string[] = [];
  arrCall(
    [
      (a: number, b: string) => void seen.push(`1:${a}${b}`),
      (a: number, b: string) => void seen.push(`2:${a}${b}`),
    ],
    7,
    'x',
  );
  assertEquals(seen, ['1:7x', '2:7x']);
});

Deno.test('arrCall: accepts any iterable', () => {
  const seen: number[] = [];
  arrCall(new Set([() => void seen.push(1), () => void seen.push(2)]));
  assertEquals(seen, [1, 2]);
});

Deno.test('arrCall: an empty iterable is a no-op', () => {
  arrCall([]);
});

Deno.test('arrCall: a Set survives a callback removing itself', () => {
  // Every production caller passes a Set, where deleting during iteration is safe.
  const seen: number[] = [];
  const set = new Set<() => void>();
  const first = () => {
    seen.push(1);
    set.delete(first);
  };
  set.add(first);
  set.add(() => void seen.push(2));
  arrCall(set);
  assertEquals(seen, [1, 2]);
});

Deno.test('arrRemove: removes the first occurrence', () => {
  const arr = [1, 2, 1, 3];
  arrRemove(arr, 1);
  assertEquals(arr, [2, 1, 3]);
});

Deno.test('arrRemove: a missing value fails the assertion', () => {
  assertThrows(() => arrRemove([1], 2), AssertionError);
});

// -- functional.ts --

Deno.test('error: throws with the given message', () => {
  assertThrows(() => error('nope'), Error, 'nope');
});

Deno.test('match: dispatches on definedness, not truthiness', () => {
  const hit = (v: unknown) => `hit:${String(v)}`;
  const miss = () => 'miss';
  assertEquals(match(1, hit, miss), 'hit:1');
  assertEquals(match(0, hit, miss), 'hit:0');
  assertEquals(match('', hit, miss), 'hit:');
  assertEquals(match(false, hit, miss), 'hit:false');
  assertEquals(match(null, hit, miss), 'hit:null');
  assertEquals(match(undefined, hit, miss), 'miss');
});

Deno.test('memoize: computes once per argument identity', () => {
  let calls = 0;
  const f = memoize((arg: { n: number }) => (calls++, { doubled: arg.n * 2 }));
  const a = { n: 2 };
  assertStrictEquals(f(a), f(a));
  assertEquals(calls, 1);
  assertEquals(f(a).doubled, 4);
});

Deno.test('memoize: distinct arguments get distinct results', () => {
  let calls = 0;
  const f = memoize((arg: { n: number }) => (calls++, arg.n * 2));
  assertEquals(f({ n: 1 }), 2);
  assertEquals(f({ n: 2 }), 4);
  assertEquals(calls, 2);
});

// memoize's contract is compute-once per argument, including falsy results --
// `bin2str` in src/util/buffer.ts memoizes a decoder that returns '' for an empty buffer.
Deno.test('memoize caches falsy results', () => {
  let calls = 0;
  const f = memoize((_arg: object) => (calls++, 0));
  const key = {};
  f(key);
  f(key);
  f(key);
  assertEquals(calls, 1);
});

Deno.test('mapEntries: maps values and passes the key', () => {
  const seen: string[] = [];
  const out = mapEntries({ a: 1, b: 2 }, (k, v) => (seen.push(k), `${k}${v}`));
  assertEquals(out, { a: 'a1', b: 'b2' });
  assertEquals(seen, ['a', 'b']);
});

Deno.test('mapEntries: an empty record maps to an empty record', () => {
  assertEquals(mapEntries({}, () => 1), {});
});

Deno.test('mapEntries: numeric keys arrive as strings', () => {
  const seen: unknown[] = [];
  mapEntries({ 1: 'a' } as Record<number, string>, (k, v) => (seen.push(typeof k), v));
  assertEquals(seen, ['string']);
});

Deno.test('mapEntries: symbol keys are silently dropped', () => {
  // Object.entries never enumerates symbols, though the signature permits them.
  const sym = Symbol('s');
  assertEquals(mapEntries({ [sym]: 1 } as Record<symbol, number>, (_k, v) => v + 1), {});
});

Deno.test('mapOne: no match yields undefined', () => {
  assertEquals(mapOne([1, 2, 3], () => undefined), undefined);
  assertEquals(mapOne([], () => 1), undefined);
});

Deno.test('mapOne: exactly one match yields that value', () => {
  assertEquals(mapOne([1, 2, 3], (el) => el === 2 ? 'two' : undefined), 'two');
});

Deno.test('mapOne: a falsy but defined result still counts as the match', () => {
  assertEquals(mapOne([1, 2, 3], (el) => el === 2 ? 0 : undefined), 0);
  assertEquals(mapOne([1, 2, 3], (el) => el === 2 ? false : undefined), false);
  assertEquals(mapOne([1, 2, 3], (el) => el === 2 ? '' : undefined), '');
});

Deno.test('mapOne: two matches throw', () => {
  assertThrows(
    () => mapOne([1, 2, 3], (el) => el > 1 ? el : undefined),
    Error,
    'More than one element mapped to a truthy value!',
  );
});

Deno.test('mapOne: passes index and array to the mapper', () => {
  const seen: [number, number][] = [];
  mapOne([9, 8], (el, idx, arr) => {
    seen.push([el, idx]);
    assertEquals(arr.length, 2);
    return undefined;
  });
  assertEquals(seen, [[9, 0], [8, 1]]);
});

Deno.test('mapOne: maps the whole array before detecting a duplicate match', () => {
  let calls = 0;
  assertThrows(() =>
    mapOne([1, 2, 3, 4], (el) => {
      calls++;
      return el < 3 ? el : undefined;
    })
  );
  assertEquals(calls, 4);
});

Deno.test('range: produces 0..size-1', () => {
  assertEquals(range(0), []);
  assertEquals(range(1), [0]);
  assertEquals(range(3), [0, 1, 2]);
});

Deno.test('range: a negative size yields an empty array', () => {
  assertEquals(range(-1), []);
});
