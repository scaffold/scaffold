import { assert, assertEquals } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import {
  statusHash,
  encodeStatusData,
  decodeStatusData,
  makeStatusOutput,
} from '../../src/demo/StatusContract.ts';
import { deriveIdentity } from '../../src/demo/Identity.ts';

Deno.test('StatusContract: statusHash follows SBL convention', () => {
  const SBL = Hash.fromLiteralStr('SBL'.padEnd(32, '\0'));
  const expected = Hash.xor(SBL, Hash.fromLiteralStr('status'));
  assert(Hash.equals(statusHash, expected));
});

Deno.test('StatusContract: encode/decode roundtrip — simple message', () => {
  const identity = deriveIdentity('eagle');
  const data = encodeStatusData(identity.publicKey, 'Hello world');
  const decoded = decodeStatusData(data);

  assertEquals(decoded.publicKey, identity.publicKey);
  assertEquals(decoded.message, 'Hello world');
});

Deno.test('StatusContract: encode/decode roundtrip — empty message', () => {
  const identity = deriveIdentity('badger');
  const data = encodeStatusData(identity.publicKey, '');
  const decoded = decodeStatusData(data);

  assertEquals(decoded.publicKey, identity.publicKey);
  assertEquals(decoded.message, '');
});

Deno.test('StatusContract: encode/decode roundtrip — unicode message', () => {
  const identity = deriveIdentity('crane');
  const data = encodeStatusData(identity.publicKey, 'Hello \u{1F600} world \u{1F30D}');
  const decoded = decodeStatusData(data);

  assertEquals(decoded.publicKey, identity.publicKey);
  assertEquals(decoded.message, 'Hello \u{1F600} world \u{1F30D}');
});

Deno.test('StatusContract: encode/decode roundtrip — long message', () => {
  const identity = deriveIdentity('dolphin');
  const longMsg = 'x'.repeat(10000);
  const data = encodeStatusData(identity.publicKey, longMsg);
  const decoded = decodeStatusData(data);

  assertEquals(decoded.publicKey, identity.publicKey);
  assertEquals(decoded.message, longMsg);
});

Deno.test('StatusContract: makeStatusOutput produces correct structure', () => {
  const identity = deriveIdentity('falcon');
  const output = makeStatusOutput(identity.publicKey, 'test');

  assert(Hash.equals(output.contract, statusHash));
  assertEquals(output.value, 1);

  const decoded = decodeStatusData(output.data);
  assertEquals(decoded.publicKey, identity.publicKey);
  assertEquals(decoded.message, 'test');
});
