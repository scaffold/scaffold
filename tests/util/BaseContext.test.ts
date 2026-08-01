import { assert, assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import { BaseContext } from '../../src/util/BaseContext.ts';

class TestContext extends BaseContext {}

class Leaf {
  value = 1;
}

class Dep {
  constructor(public ctx: TestContext) {}
}

class Owner {
  dep: Dep;
  constructor(ctx: TestContext) {
    this.dep = ctx.get(Dep);
  }
}

// -- construction and caching --

Deno.test('BaseContext: get constructs lazily and caches by identity', () => {
  const ctx = new TestContext();
  assertEquals(ctx.debugGetAll().size, 0);
  const a = ctx.get(Leaf);
  assertStrictEquals(ctx.get(Leaf), a);
  assertEquals(ctx.debugGetAll().size, 1);
});

Deno.test('BaseContext: the constructor receives the context', () => {
  const ctx = new TestContext();
  assertStrictEquals(ctx.get(Dep).ctx, ctx);
});

Deno.test('BaseContext: dependencies are constructed on demand', () => {
  const ctx = new TestContext();
  const owner = ctx.get(Owner);
  assertStrictEquals(owner.dep, ctx.get(Dep));
});

Deno.test('BaseContext: distinct types get distinct instances', () => {
  const ctx = new TestContext();
  assert(ctx.get(Leaf) !== (ctx.get(Dep) as unknown));
});

Deno.test('BaseContext: contexts do not share instances', () => {
  const a = new TestContext();
  const b = new TestContext();
  assert(a.get(Leaf) !== b.get(Leaf));
});

// -- maybeGet --

Deno.test('BaseContext: maybeGet does not construct', () => {
  const ctx = new TestContext();
  assertEquals(ctx.maybeGet(Leaf), undefined);
  assertEquals(ctx.debugGetAll().size, 0);
  const leaf = ctx.get(Leaf);
  assertStrictEquals(ctx.maybeGet(Leaf), leaf);
});

// -- recursion detection --

class SelfRecursive {
  constructor(ctx: TestContext) {
    ctx.get(SelfRecursive);
  }
}

class MutualA {
  constructor(ctx: TestContext) {
    ctx.get(MutualB);
  }
}

class MutualB {
  constructor(ctx: TestContext) {
    ctx.get(MutualA);
  }
}

let recurseOnce = true;
class RecurseOnce {
  constructed = true;
  constructor(ctx: TestContext) {
    if (recurseOnce) {
      recurseOnce = false;
      ctx.get(RecurseOnce);
    }
  }
}

Deno.test('BaseContext: a self-recursive constructor is reported by name', () => {
  const ctx = new TestContext();
  assertThrows(
    () => ctx.get(SelfRecursive),
    Error,
    'Constructor for SelfRecursive is probably recursive',
  );
});

Deno.test('BaseContext: mutual recursion is detected', () => {
  const ctx = new TestContext();
  assertThrows(() => ctx.get(MutualA), Error, 'is probably recursive');
});

Deno.test('BaseContext: a failed construction leaves the context usable', () => {
  const ctx = new TestContext();
  assertThrows(() => ctx.get(SelfRecursive));
  assertEquals(ctx.debugGetAll().size, 0);
  assertEquals(ctx.get(Leaf).value, 1);
});

Deno.test('BaseContext: the recursion guard is cleared so a retry can succeed', () => {
  recurseOnce = true;
  const ctx = new TestContext();
  assertThrows(() => ctx.get(RecurseOnce), Error, 'is probably recursive');
  assert(ctx.get(RecurseOnce).constructed);
});

class Throwing {
  constructor(_ctx: TestContext) {
    throw new Error('ctor boom');
  }
}

Deno.test('BaseContext: a throwing constructor is not cached', () => {
  const ctx = new TestContext();
  assertThrows(() => ctx.get(Throwing), Error, 'ctor boom');
  assertEquals(ctx.maybeGet(Throwing), undefined);
  assertThrows(() => ctx.get(Throwing), Error, 'ctor boom');
});

// -- mock --

Deno.test('BaseContext: mock before construction wins', () => {
  const ctx = new TestContext();
  const fake = { value: 42 };
  ctx.mock(Leaf, fake);
  assertStrictEquals(ctx.get(Leaf), fake);
  assertStrictEquals(ctx.maybeGet(Leaf), fake);
});

Deno.test('BaseContext: mock after construction throws', () => {
  const ctx = new TestContext();
  ctx.get(Leaf);
  assertThrows(
    () => ctx.mock(Leaf, { value: 42 }),
    Error,
    `Cannot mock Leaf after it's been constructed!`,
  );
});

Deno.test('BaseContext: mocking twice throws', () => {
  const ctx = new TestContext();
  ctx.mock(Leaf, { value: 1 });
  assertThrows(() => ctx.mock(Leaf, { value: 2 }), Error, 'after');
});

Deno.test('BaseContext: a mocked dependency is used by its dependents', () => {
  const ctx = new TestContext();
  const fake = { ctx: null as unknown as TestContext };
  ctx.mock(Dep, fake);
  assertStrictEquals(ctx.get(Owner).dep, fake);
});

Deno.test('BaseContext: a mock disposer is never registered', () => {
  // mock() bypasses get()'s construction path, so the mock owns its own lifetime.
  const ctx = new TestContext();
  let disposed = false;
  const fake: Leaf & Disposable = {
    value: 1,
    [Symbol.dispose]: () => void (disposed = true),
  };
  ctx.mock(Leaf, fake);
  ctx.get(Leaf);
  ctx.destruct();
  assertEquals(disposed, false);
});

// -- destruction ordering --

Deno.test('BaseContext: onDestruct callbacks run in reverse registration order', () => {
  const ctx = new TestContext();
  const order: string[] = [];
  ctx.onDestruct(() => void order.push('a'));
  ctx.onDestruct(() => void order.push('b'));
  ctx.onDestruct(() => void order.push('c'));
  ctx.destruct();
  assertEquals(order, ['c', 'b', 'a']);
});

Deno.test('BaseContext: dependents are disposed before their dependencies', () => {
  const order: string[] = [];
  class DisposableDep {
    [Symbol.dispose]() {
      order.push('dep');
    }
  }
  class DisposableOwner {
    constructor(ctx: TestContext) {
      ctx.get(DisposableDep);
    }
    [Symbol.dispose]() {
      order.push('owner');
    }
  }

  const ctx = new TestContext();
  ctx.get(DisposableOwner);
  ctx.destruct();
  assertEquals(order, ['owner', 'dep']);
});

Deno.test('BaseContext: disposers are registered at construction time', () => {
  const order: string[] = [];
  class Disposable {
    [Symbol.dispose]() {
      order.push('disposer');
    }
  }

  const ctx = new TestContext();
  ctx.onDestruct(() => void order.push('before'));
  ctx.get(Disposable);
  ctx.onDestruct(() => void order.push('after'));
  ctx.destruct();
  assertEquals(order, ['after', 'disposer', 'before']);
});

Deno.test('BaseContext: an unconstructed type contributes no disposer', () => {
  const order: string[] = [];
  class NeverBuilt {
    [Symbol.dispose]() {
      order.push('disposer');
    }
  }

  const ctx = new TestContext();
  ctx.maybeGet(NeverBuilt);
  ctx.destruct();
  assertEquals(order, []);
});

Deno.test('BaseContext: both dispose and asyncDispose are registered', async () => {
  const order: string[] = [];
  class Both {
    [Symbol.dispose]() {
      order.push('sync');
    }
    [Symbol.asyncDispose]() {
      order.push('async');
      return Promise.resolve();
    }
  }

  const ctx = new TestContext();
  ctx.get(Both);
  await ctx.destruct();
  assertEquals(order, ['async', 'sync']);
});

// -- sync vs async destruct --

Deno.test('BaseContext: destruct is synchronous when nothing returns a promise', () => {
  const ctx = new TestContext();
  ctx.get(Leaf);
  ctx.onDestruct(() => {});
  assertEquals(ctx.destruct(), undefined);
  assertEquals(ctx.debugGetAll().size, 0);
});

Deno.test('BaseContext: destruct of an untouched context is synchronous', () => {
  assertEquals(new TestContext().destruct(), undefined);
});

Deno.test('BaseContext: a mixed sync/async destruct awaits before resetting', async () => {
  const ctx = new TestContext();
  const order: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));

  ctx.get(Leaf);
  ctx.onDestruct(() => {
    order.push('async-start');
    return gate.then(() => void order.push('async-end'));
  });
  ctx.onDestruct(() => void order.push('sync'));

  const result = ctx.destruct();
  assert(result instanceof Promise);
  assertEquals(order, ['sync', 'async-start']);
  assertEquals(ctx.debugGetAll().size, 1);

  release();
  await result;
  assertEquals(order, ['sync', 'async-start', 'async-end']);
  assertEquals(ctx.debugGetAll().size, 0);
});

Deno.test('BaseContext: async destructors are started, not serialised', async () => {
  const ctx = new TestContext();
  const order: string[] = [];
  ctx.onDestruct(async () => {
    order.push('a-start');
    await Promise.resolve();
    order.push('a-end');
  });
  ctx.onDestruct(async () => {
    order.push('b-start');
    await Promise.resolve();
    order.push('b-end');
  });
  await ctx.destruct();
  assertEquals(order, ['b-start', 'a-start', 'b-end', 'a-end']);
});

// -- destruct guards --

Deno.test('BaseContext: destructing twice throws', () => {
  const ctx = new TestContext();
  ctx.destruct();
  assertThrows(() => ctx.destruct(), Error, 'Cannot destruct a context twice!');
});

Deno.test('BaseContext: destructing during an async destruct throws', async () => {
  const ctx = new TestContext();
  ctx.onDestruct(() => Promise.resolve());
  const result = ctx.destruct();
  assertThrows(() => ctx.destruct(), Error, 'Cannot destruct a context twice!');
  await result;
});

Deno.test('BaseContext: get after destruct throws', () => {
  const ctx = new TestContext();
  ctx.get(Leaf);
  ctx.destruct();
  assertThrows(() => ctx.get(Leaf), Error, `Cannot use a context after it's been destructed!`);
  assertThrows(() => ctx.get(Dep), Error, 'destructed');
});

Deno.test('BaseContext: maybeGet after destruct yields undefined', () => {
  const ctx = new TestContext();
  ctx.get(Leaf);
  ctx.destruct();
  assertEquals(ctx.maybeGet(Leaf), undefined);
});

Deno.test('BaseContext: destruct clears the instances and the destructors', () => {
  const ctx = new TestContext();
  ctx.get(Leaf);
  ctx.get(Owner);
  assertEquals(ctx.debugGetAll().size, 3);
  ctx.destruct();
  assertEquals(ctx.debugGetAll().size, 0);
});

Deno.test('BaseContext: a destructor may still reach already-built services', () => {
  const ctx = new TestContext();
  let seen: Leaf | undefined;
  const leaf = ctx.get(Leaf);
  ctx.onDestruct(() => void (seen = ctx.get(Leaf)));
  ctx.destruct();
  assertStrictEquals(seen, leaf);
});

Deno.test('BaseContext: a destructor registering another destructor is silently dropped', () => {
  const order: string[] = [];
  const ctx = new TestContext();
  ctx.onDestruct(() => {
    order.push('outer');
    ctx.onDestruct(() => void order.push('inner'));
  });
  ctx.destruct();
  assertEquals(order, ['outer']);
});

Deno.test('BaseContext: a throwing destructor aborts the remaining teardown', () => {
  const order: string[] = [];
  const ctx = new TestContext();
  ctx.get(Leaf);
  ctx.onDestruct(() => void order.push('first-registered'));
  ctx.onDestruct(() => {
    throw new Error('teardown boom');
  });
  assertThrows(() => ctx.destruct(), Error, 'teardown boom');
  assertEquals(order, []);
  assertEquals(ctx.debugGetAll().size, 1);
  assertThrows(() => ctx.destruct(), Error, 'Cannot destruct a context twice!');
});
