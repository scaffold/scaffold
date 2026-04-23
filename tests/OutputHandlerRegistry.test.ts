import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { OutputHandlerRegistry } from '../src/core/OutputHandlerRegistry.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const v = (contract: string, params: string) => ({
  contract: Hash.digest(contract),
  params: enc(params),
});

Deno.test('OutputHandlerRegistry: empty registry returns null', async () => {
  const reg = new OutputHandlerRegistry();
  const result = await reg.resolve(
    Hash.digest('running'),
    enc('p'),
    v('out', 'x'),
  );
  assertEquals(result, null);
});

Deno.test('OutputHandlerRegistry: builtin resolver hit', async () => {
  const reg = new OutputHandlerRegistry();
  reg.registerBuiltin(async () => ({ value: 7, data: enc('from-builtin') }));
  const result = await reg.resolve(
    Hash.digest('running'),
    enc('p'),
    v('out', 'x'),
  );
  assertEquals(result, { value: 7, data: enc('from-builtin') });
});

Deno.test('OutputHandlerRegistry: builtins tried before user handlers', async () => {
  const reg = new OutputHandlerRegistry();
  const order: string[] = [];
  reg.registerBuiltin(async () => {
    order.push('builtin');
    return { value: 1, data: enc('b') };
  });
  reg.registerUser(Hash.digest('running'), async () => {
    order.push('user');
    return { value: 2, data: enc('u') };
  });
  const result = await reg.resolve(
    Hash.digest('running'),
    enc('p'),
    v('out', 'x'),
  );
  assertEquals(order, ['builtin']);
  assertEquals(result?.value, 1);
});

Deno.test('OutputHandlerRegistry: null defers to next handler', async () => {
  const reg = new OutputHandlerRegistry();
  reg.registerBuiltin(async () => null);
  reg.registerUser(Hash.digest('running'), async () => ({
    value: 9,
    data: enc('fallback'),
  }));
  const result = await reg.resolve(
    Hash.digest('running'),
    enc('p'),
    v('out', 'x'),
  );
  assertEquals(result?.value, 9);
});

Deno.test('OutputHandlerRegistry: user handlers run in registration order per contract', async () => {
  const reg = new OutputHandlerRegistry();
  const running = Hash.digest('running');
  const order: string[] = [];
  reg.registerUser(running, async () => {
    order.push('first');
    return null;
  });
  reg.registerUser(running, async () => {
    order.push('second');
    return { value: 2, data: enc('s') };
  });
  await reg.resolve(running, enc('p'), v('out', 'x'));
  assertEquals(order, ['first', 'second']);
});

Deno.test('OutputHandlerRegistry: user handler scoped to running contract hash', async () => {
  const reg = new OutputHandlerRegistry();
  const runningA = Hash.digest('A');
  const runningB = Hash.digest('B');
  reg.registerUser(runningA, async () => ({ value: 1, data: enc('a') }));
  const resultB = await reg.resolve(runningB, enc('p'), v('out', 'x'));
  assertEquals(resultB, null);
  const resultA = await reg.resolve(runningA, enc('p'), v('out', 'x'));
  assertEquals(resultA?.value, 1);
});

Deno.test('OutputHandlerRegistry: unsubscribe removes handler', async () => {
  const reg = new OutputHandlerRegistry();
  const running = Hash.digest('running');
  const unsub = reg.registerUser(running, async () => ({
    value: 5,
    data: enc('x'),
  }));
  unsub();
  const result = await reg.resolve(running, enc('p'), v('out', 'x'));
  assertEquals(result, null);
});
