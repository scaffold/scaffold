import { assertEquals, assertRejects } from '@std/assert';
import { blobContract } from '../../../src/contract/static/Blob.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import { Hash } from '../../../src/util/Hash.ts';
import { str2bin } from '../../../src/util/buffer.ts';

const HASH = Hash.digest('abc');

Deno.test('blob params are built from the content hash', async () => {
  assertEquals(
    await blobContract.buildParams!(() => createSource({ hash: HASH.toBytes() })),
    HASH.toBytes(),
  );
});

Deno.test('walking blob params exposes the content hash', async () => {
  assertEquals(
    await createSink((sink) => blobContract.walkParams!(HASH.toBytes(), sink)),
    { hash: HASH.toBytes() },
  );
});

Deno.test('a hash that is not 32 bytes is rejected', async () => {
  await assertRejects(async () => {
    await blobContract.buildParams!(() => createSource({ hash: str2bin('abcd') }));
  });
});

Deno.test('a blob body is the preimage itself', async () => {
  assertEquals(await blobContract.buildBody!(() => createSource(str2bin('abc'))), str2bin('abc'));
  assertEquals(
    await createSink((sink) => blobContract.walkBody!(str2bin('abc'), sink)),
    str2bin('abc'),
  );
});
