import { assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
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
import { error } from '../../src/util/functional.ts';

// -- mapPut --

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

// `NotUndefined` keeps an undefined value out of the map, because mapPut reads a stored
// undefined as absent and would recompute it on every call.
Deno.test('mapPut: an undefined value does not typecheck', () => {
  const m = new Map<string, number | undefined>();
  // @ts-expect-error V is constrained to NotUndefined
  mapPut(m, 'a', () => undefined);
  assertEquals(m.has('a'), true);
});

Deno.test('getOrCreate: is mapPut', () => {
  assertStrictEquals(getOrCreate, mapPut);
});

// -- mapPop --

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

// -- mapInc / mapDec --

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

// -- multimap --

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
