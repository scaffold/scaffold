import { assertEquals, assertRejects } from '@std/assert';
import {
  counterContract,
  counterIncrementPredicate,
} from '../../../src/contract/static/Counter.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import { bin2str } from '../../../src/util/buffer.ts';

Deno.test('counter params round-trip through the mode and kind slots', async () => {
  const built = await counterContract.buildParams!(() =>
    createSource({ mode: 'count', kind: 'inc' })
  );
  assertEquals(built, counterIncrementPredicate.params);
  assertEquals(
    await createSink((sink) => counterContract.walkParams!(built, sink)),
    { mode: 'count', kind: 'inc' },
  );
});

Deno.test('params that are not a map are rejected', async () => {
  await assertRejects(async () => {
    await counterContract.buildParams!(() => createSource('count'));
  });
});

// Both body codecs need a way to tell a chain body from an increment body.
Deno.test({
  name: 'an increment body round-trips through its increment',
  ignore: true,
  fn: async () => {
    const body = await counterContract.buildBody!(() => createSource({ inc: 1 }));
    assertEquals(bin2str(body), '{"inc":1}');
    assertEquals(await createSink((sink) => counterContract.walkBody!(body, sink)), { inc: 1 });
  },
});

Deno.test({
  name: 'a chain body round-trips through its sum',
  ignore: true,
  fn: async () => {
    const body = await counterContract.buildBody!(() => createSource({ sum: -2 }));
    assertEquals(bin2str(body), '{"sum":-2}');
    assertEquals(await createSink((sink) => counterContract.walkBody!(body, sink)), { sum: -2 });
  },
});
