import { assert, assertFalse } from '@std/assert';
import { createGenesisBlock } from '../../src/Block.ts';
import { deriveIdentity } from '../../src/demo/Identity.ts';
import { makeStatusOutput } from '../../src/demo/StatusContract.ts';
import {
  signBlock,
  verifyBlockSignature,
  recoverSignerPublicKey,
} from '../../src/demo/SignedBlock.ts';

function makeTestBlock() {
  const eagle = deriveIdentity('eagle');
  return createGenesisBlock([makeStatusOutput(eagle.publicKey, 'test')]);
}

Deno.test('SignedBlock: sign + verify roundtrip succeeds', () => {
  const eagle = deriveIdentity('eagle');
  const block = makeTestBlock();
  const sb = signBlock(block, eagle.privateKey);

  assert(verifyBlockSignature(sb, eagle.publicKey));
});

Deno.test('SignedBlock: verification fails with wrong public key', () => {
  const eagle = deriveIdentity('eagle');
  const badger = deriveIdentity('badger');
  const block = makeTestBlock();
  const sb = signBlock(block, eagle.privateKey);

  assertFalse(verifyBlockSignature(sb, badger.publicKey));
});

Deno.test('SignedBlock: public key recovery works', () => {
  const eagle = deriveIdentity('eagle');
  const block = makeTestBlock();
  const sb = signBlock(block, eagle.privateKey);

  const recovered = recoverSignerPublicKey(sb);
  assert(recovered !== undefined);
  assert(bytesEqual(recovered!, eagle.publicKey));
});

Deno.test('SignedBlock: signature is 64 bytes', () => {
  const eagle = deriveIdentity('eagle');
  const block = makeTestBlock();
  const sb = signBlock(block, eagle.privateKey);

  assert(sb.signature.length === 64);
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
