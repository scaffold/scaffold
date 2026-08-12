import { assertEquals, assertRejects } from '@std/assert';
import { signatureContract } from '../../../src/contract/static/Signature.ts';
import { createSink } from '../../../src/contract/createSink.ts';
import { createSource } from '../../../src/contract/createSource.ts';
import { Hash } from '../../../src/util/Hash.ts';
import { secp } from '../../../src/util/secp.ts';

const PRIVATE_KEY = Hash.digest('scaffold:testnet:alice').toBytes();
const PUBLIC_KEY = secp.getPublicKey(PRIVATE_KEY, true);

Deno.test('signature params are built from the public key', async () => {
  assertEquals(
    await signatureContract.buildParams!(() => createSource({ publicKey: PUBLIC_KEY })),
    PUBLIC_KEY,
  );
});

Deno.test('walking signature params exposes the public key', async () => {
  assertEquals(
    await createSink((sink) => signatureContract.walkParams!(PUBLIC_KEY, sink)),
    { publicKey: PUBLIC_KEY },
  );
});

Deno.test('an uncompressed public key is rejected', async () => {
  await assertRejects(async () => {
    await signatureContract.buildParams!(() =>
      createSource({ publicKey: secp.getPublicKey(PRIVATE_KEY, false) })
    );
  });
});
