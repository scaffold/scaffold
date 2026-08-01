import {
  assertEquals,
  assertExists,
  AssertionError,
  assertNotEquals,
  assertThrows,
} from '@std/assert';
import { type Config, makeDefaultConfig } from '../src/Config.ts';
import { BlockStore } from '../src/core/BlockStore.ts';
import { AtomSource, type Block } from '../src/core/types.ts';
import { generateGenesis } from '../src/genesis.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { bin2hex } from '../src/util/hex.ts';
import { makeTestContext, testPrivateKey, testPublicKey } from './helpers/v2.ts';

/** Funding map keyed by public key, with insertion order fixed by the tuple list. */
const funding = (entries: [string, bigint][]): Record<string, bigint> =>
  Object.fromEntries(entries.map(([name, amount]) => [bin2hex(testPublicKey(name)), amount]));

const deserialize = (raw: Uint8Array): Block =>
  makeTestContext().get(BlockStore).ingest({ source: AtomSource.Genesis, receivedAt: 0, raw });

Deno.test('generateGenesis is byte-identical across separate calls', () => {
  const entries: [string, bigint][] = [['alice', 1_000_000n], ['bob', 7n]];
  const a = generateGenesis('seed', funding(entries));
  const b = generateGenesis('seed', funding(entries));
  assertEquals(bin2hex(a), bin2hex(b));
});

Deno.test('changing the seed changes the bytes but not the payload', () => {
  const entries: [string, bigint][] = [['alice', 1_000_000n]];
  const a = deserialize(generateGenesis('seed-a', funding(entries)));
  const b = deserialize(generateGenesis('seed-b', funding(entries)));

  // The seed selects the signing identity only, so the signed message is untouched.
  assertEquals(bin2hex(a.message), bin2hex(b.message));
  assertNotEquals(bin2hex(a.raw), bin2hex(b.raw));
  assertNotEquals(bin2hex(a.signer!), bin2hex(b.signer!));
  assertNotEquals(a.hash.toHex(), b.hash.toHex());
});

Deno.test('changing any funding entry changes the bytes', () => {
  const base = generateGenesis('seed', funding([['alice', 100n], ['bob', 5n]]));
  const variants = [
    generateGenesis('seed', funding([['alice', 101n], ['bob', 5n]])),
    generateGenesis('seed', funding([['alice', 100n], ['bob', 6n]])),
    generateGenesis('seed', funding([['alice', 100n], ['charlie', 5n]])),
    generateGenesis('seed', funding([['alice', 100n]])),
    generateGenesis('seed', funding([['alice', 100n], ['bob', 5n], ['charlie', 1n]])),
    generateGenesis('seed', funding([['bob', 5n], ['alice', 100n]])),
  ];
  for (const variant of variants) {
    assertNotEquals(bin2hex(variant), bin2hex(base));
  }
});

Deno.test('genesis signing never reuses randomness across different blocks', () => {
  // Reusing (key, nonce) across two different messages leaks the private key, so
  // the derived seed hash must move whenever the seed or the funding set moves.
  const blocks = [
    generateGenesis('seed-a', funding([['alice', 100n]])),
    generateGenesis('seed-b', funding([['alice', 100n]])),
    generateGenesis('seed-a', funding([['alice', 101n]])),
    generateGenesis('seed-a', funding([['bob', 100n]])),
    generateGenesis('seed-a', funding([['alice', 100n], ['bob', 5n]])),
    generateGenesis('seed-a', funding([['bob', 5n], ['alice', 100n]])),
  ].map(deserialize);

  const nonces = new Set(blocks.map((b) => bin2hex(b.signature!.subarray(0, 32))));
  assertEquals(nonces.size, blocks.length);

  for (const a of blocks) {
    for (const b of blocks) {
      if (bin2hex(a.signer!) !== bin2hex(b.signer!)) continue;
      assertEquals(bin2hex(a.message), bin2hex(b.message));
    }
  }
});

Deno.test('generateGenesis rejects a public key that is not 33 bytes', () => {
  // A 32-byte private key is exactly the mistake makeDefaultConfig makes.
  assertThrows(
    () => generateGenesis('seed', { [bin2hex(testPrivateKey('alice'))]: 1n }),
    AssertionError,
    'public key must be 33 bytes',
  );
});

Deno.test('generateGenesis rejects a negative amount', () => {
  assertThrows(
    () => generateGenesis('seed', funding([['alice', -1n]])),
    AssertionError,
    'amount must be non-negative',
  );
});

Deno.test('genesis outputs land in insertion order with the right amounts', () => {
  const raw = generateGenesis('seed', funding([['alice', 1n], ['bob', 2n], ['charlie', 3n]]));
  const outputs = deserialize(raw).payload.outputs;

  assertEquals(outputs.length, 3);
  assertEquals(outputs.map((o) => o.amount), [1n, 2n, 3n]);
  assertEquals(outputs.map((o) => bin2hex(o.params)), [
    bin2hex(testPublicKey('alice')),
    bin2hex(testPublicKey('bob')),
    bin2hex(testPublicKey('charlie')),
  ]);
  for (const output of outputs) {
    assertEquals(Hash.equals(output.contract, ZERO_HASH), true);
    assertEquals(output.data, undefined);
  }
});

Deno.test('genesis deserializes to a rootless block with no claims, refs, or aggregates', () => {
  const block = deserialize(generateGenesis('seed', funding([['alice', 100n]])));

  assertEquals(Hash.equals(block.payload.anchor, ZERO_HASH), true);
  assertEquals(block.anchor, undefined);
  assertEquals(block.payload.claims, []);
  assertEquals(block.payload.refs, []);
  assertEquals(block.payload.aggregates, []);
  assertEquals(block.payload.chain, []);
  assertEquals(block.payload.timestampMs, 0);
  assertEquals(block.claims, []);
  assertEquals(block.refs, []);
  assertEquals(block.aggregates, []);
  assertExists(block.signer);
});

Deno.test('generateGenesis accepts an empty funding set', () => {
  const block = deserialize(generateGenesis('seed', {}));
  assertEquals(block.payload.outputs, []);
});

Deno.test('makeDefaultConfig returns a usable config', () => {
  const config: Config = makeDefaultConfig();
  assertExists(config.genesis);
  assertExists(config.selfPrivateKey);
});
