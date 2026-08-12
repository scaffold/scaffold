import { assertEquals, assertRejects } from '@std/assert';
import { exactBlockContract } from '../../../src/contract/static/ExactBlock.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import { Hash } from '../../../src/util/Hash.ts';

const BLOCK = Hash.digest('block');

Deno.test('exact_block params are built from the block hash', async () => {
  assertEquals(
    await exactBlockContract.buildParams!(() => createSource({ block: BLOCK.toBytes() })),
    BLOCK.toBytes(),
  );
});

Deno.test('walking exact_block params exposes the block hash', async () => {
  assertEquals(
    await createSink((sink) => exactBlockContract.walkParams!(BLOCK.toBytes(), sink)),
    { block: BLOCK.toBytes() },
  );
});

Deno.test('a block hash that is not 32 bytes is rejected', async () => {
  await assertRejects(async () => {
    await exactBlockContract.buildParams!(() => createSource({ block: new Uint8Array(31) }));
  });
});
