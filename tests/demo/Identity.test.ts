import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { ANIMALS, deriveIdentity } from '../../src/demo/Identity.ts';

Deno.test('Identity: all 10 identities produce distinct 33-byte public keys', () => {
  const publicKeys = new Set<string>();

  for (const name of ANIMALS) {
    const identity = deriveIdentity(name);
    assertEquals(identity.publicKey.length, 33, `${name} publicKey should be 33 bytes`);

    const hex = Array.from(identity.publicKey).map((b) => b.toString(16).padStart(2, '0')).join('');
    assert(!publicKeys.has(hex), `${name} has duplicate publicKey`);
    publicKeys.add(hex);
  }

  assertEquals(publicKeys.size, 10);
});

Deno.test('Identity: derivation is deterministic', () => {
  const a = deriveIdentity('eagle');
  const b = deriveIdentity('eagle');

  assertEquals(a.name, b.name);
  assertEquals(a.privateKey, b.privateKey);
  assertEquals(a.publicKey, b.publicKey);
});

Deno.test('Identity: private keys are 32 bytes', () => {
  for (const name of ANIMALS) {
    const identity = deriveIdentity(name);
    assertEquals(identity.privateKey.length, 32, `${name} privateKey should be 32 bytes`);
  }
});

Deno.test('Identity: different names produce different keys', () => {
  const eagle = deriveIdentity('eagle');
  const badger = deriveIdentity('badger');

  assertNotEquals(eagle.privateKey, badger.privateKey);
  assertNotEquals(eagle.publicKey, badger.publicKey);
});
