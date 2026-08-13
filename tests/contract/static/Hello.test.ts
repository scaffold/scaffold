import { assertEquals } from '@std/assert';
import { helloContract } from '../../../src/contract/static/Hello.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import { str2bin } from '../../../src/util/buffer.ts';

Deno.test('hello params round-trip through the name', async () => {
  const built = await helloContract.buildParams!(() => createSource({ name: 'Joel' }));
  assertEquals(built, str2bin('Joel'));
  assertEquals(await createSink((sink) => helloContract.walkParams!(built, sink)), {
    name: 'Joel',
  });
});

Deno.test('the hello body round-trips through the message', async () => {
  const built = await helloContract.buildBody!(() => createSource({ message: 'Hello, Joel' }));
  assertEquals(built, str2bin('Hello, Joel'));
  assertEquals(await createSink((sink) => helloContract.walkBody!(built, sink)), {
    message: 'Hello, Joel',
  });
});
