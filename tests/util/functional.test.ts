import {
  assertEquals,
  AssertionError,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { error, mapEntries, mapOne, match, once, range } from '../../src/util/functional.ts';

Deno.test('error: throws with the given message', () => {
  assertThrows(() => error('nope'), Error, 'nope');
});

// -- once --

Deno.test('once: a receiverless function computes on the first call and reuses the result', () => {
  let calls = 0;
  const f = once(function () {
    calls++;
    return { n: calls };
  });
  const first = f();
  assertStrictEquals(f(), first);
  assertStrictEquals(f(), first);
  assertEquals(calls, 1);
});

Deno.test('once: each receiver gets its own result', () => {
  let calls = 0;
  const f = once(function (this: { id: string }) {
    calls++;
    return `${this.id}:${calls}`;
  });
  const a = { id: 'a' };
  const b = { id: 'b' };
  assertEquals(f.call(a), 'a:1');
  assertEquals(f.call(b), 'b:2');
  assertEquals(f.call(a), 'a:1');
  assertEquals(calls, 2);
});

Deno.test('once: wrapping the same function twice yields independent caches', () => {
  let calls = 0;
  const fn = function (this: object) {
    return ++calls;
  };
  const f = once(fn);
  const g = once(fn);
  const receiver = {};
  assertEquals(f.call(receiver), 1);
  assertEquals(g.call(receiver), 2);
  assertEquals(f.call(receiver), 1);
});

Deno.test('once: an argument-keyed function computes once per argument identity', () => {
  let calls = 0;
  const f = once((arg: { n: number }) => (calls++, { doubled: arg.n * 2 }));
  const a = { n: 2 };
  assertStrictEquals(f(a), f(a));
  assertEquals(calls, 1);
  assertEquals(f(a).doubled, 4);
});

Deno.test('once: distinct arguments get distinct results', () => {
  let calls = 0;
  const f = once((arg: { n: number }) => (calls++, arg.n * 2));
  assertEquals(f({ n: 1 }), 2);
  assertEquals(f({ n: 2 }), 4);
  assertEquals(calls, 2);
});

// `bin2str` in src/util/buffer.ts keys a decoder that returns '' for an empty buffer.
Deno.test('once: falsy results are cached', () => {
  let calls = 0;
  const f = once((_arg: object) => (calls++, 0));
  const key = {};
  f(key);
  f(key);
  f(key);
  assertEquals(calls, 1);
});

Deno.test('once: the argument reaches the wrapped function', () => {
  const seen: unknown[] = [];
  const f = once((arg: { n: number }) => (seen.push(arg), arg.n));
  const arg = { n: 7 };
  assertEquals(f(arg), 7);
  assertEquals(seen, [arg]);
});

Deno.test('once: keying on both a receiver and an argument throws', () => {
  const f = once((arg: object) => arg) as (this: object, arg: object) => object;
  assertThrows(
    () => f.call({}, {}),
    AssertionError,
    'once: keyed on a receiver and an argument',
  );
});

Deno.test('once: a throwing call is not cached and runs again', () => {
  let calls = 0;
  const f = once(function (this: object) {
    calls++;
    if (calls < 3) error('boom');
    return 'ok';
  });
  const receiver = {};
  assertThrows(() => f.call(receiver), Error, 'boom');
  assertThrows(() => f.call(receiver), Error, 'boom');
  assertEquals(f.call(receiver), 'ok');
  assertEquals(calls, 3);
});

Deno.test('once: recursion through a different receiver is allowed', () => {
  const outer = {};
  const inner = {};
  const f: (this: object) => number = once(function (this: object) {
    return this === outer ? f.call(inner) + 1 : 1;
  });
  assertEquals(f.call(outer), 2);
  assertEquals(f.call(inner), 1);
});

Deno.test('once: a decorated method computes once per instance', () => {
  let calls = 0;
  class Counter {
    @once
    value() {
      calls++;
      return { n: calls };
    }
  }
  const counter = new Counter();
  const first = counter.value();
  assertStrictEquals(counter.value(), first);
  assertStrictEquals(counter.value(), first);
  assertEquals(calls, 1);
});

Deno.test('once: instances of a decorated class do not share a result', () => {
  let calls = 0;
  class Named {
    constructor(private id: string) {}

    @once
    describe() {
      calls++;
      return `${this.id}:${calls}`;
    }
  }
  const a = new Named('a');
  const b = new Named('b');
  assertEquals(a.describe(), 'a:1');
  assertEquals(b.describe(), 'b:2');
  assertEquals(a.describe(), 'a:1');
  assertEquals(calls, 2);
});

// `Scaffold.close` is the reason `once` exists: every caller awaits one shutdown.
Deno.test('once: a decorated async method hands every caller the same promise', async () => {
  let calls = 0;
  class Resource {
    @once
    async close() {
      calls++;
      await Promise.resolve();
      return 'closed';
    }
  }
  const resource = new Resource();
  const first = resource.close();
  assertStrictEquals(resource.close(), first);
  assertEquals(await first, 'closed');
  assertStrictEquals(resource.close(), first);
  assertEquals(calls, 1);
});

Deno.test('once: a decorated async method that rejects keeps handing back the rejection', async () => {
  let calls = 0;
  class Resource {
    @once
    close() {
      calls++;
      return Promise.reject(new Error('boom'));
    }
  }
  const resource = new Resource();
  const first = resource.close();
  assertStrictEquals(resource.close(), first);
  await assertRejects(() => first, Error, 'boom');
  assertEquals(calls, 1);
});

Deno.test('once: a decorated method returning undefined still runs only once', () => {
  let calls = 0;
  class Resource {
    @once
    release(): void {
      calls++;
    }
  }
  const resource = new Resource();
  resource.release();
  resource.release();
  assertEquals(calls, 1);
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
