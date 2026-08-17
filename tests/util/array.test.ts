import { assertEquals, AssertionError, assertThrows } from '@std/assert';
import { arrCall, arrRemove } from '../../src/util/array.ts';

Deno.test('arrCall: invokes every callback with the args', () => {
  const seen: string[] = [];
  arrCall(
    [
      (a: number, b: string) => void seen.push(`1:${a}${b}`),
      (a: number, b: string) => void seen.push(`2:${a}${b}`),
    ],
    undefined,
    7,
    'x',
  );
  assertEquals(seen, ['1:7x', '2:7x']);
});

Deno.test('arrCall: accepts any iterable', () => {
  const seen: number[] = [];
  arrCall(new Set([() => void seen.push(1), () => void seen.push(2)]), undefined);
  assertEquals(seen, [1, 2]);
});

Deno.test('arrCall: an empty iterable is a no-op', () => {
  arrCall([], undefined);
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
  arrCall(set, undefined);
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
