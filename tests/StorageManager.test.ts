import { assert, assertEquals } from '@std/assert';
import { secp } from '../src/util/secp.ts';
import { Block, createGenesisBlock } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { composeBlockPacket } from '../src/core/Packet.ts';
import { StorageManager, StoragePlugin } from '../src/node/StorageManager.ts';

// -- Mock storage plugin -------------------------------------------

class MockStoragePlugin implements StoragePlugin {
  readonly store = new Map<string, Uint8Array>();

  loadAll(): Promise<Array<{ hash: string; data: Uint8Array }>> {
    const entries: Array<{ hash: string; data: Uint8Array }> = [];
    for (const [hash, data] of this.store) {
      entries.push({ hash, data });
    }
    return Promise.resolve(entries);
  }

  save(hash: string, data: Uint8Array): Promise<void> {
    this.store.set(hash, data);
    return Promise.resolve();
  }

  remove(hash: string): Promise<void> {
    this.store.delete(hash);
    return Promise.resolve();
  }
}

// -- Helpers --------------------------------------------------------

function makeSignedPacket(
  anchor: Block,
  label: string,
): { block: Block; raw: Uint8Array; publicKey: Uint8Array } {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  const { block, packet } = composeBlockPacket(
    {
      anchor: anchor.hash,
      aggregates: [],
      claims: [],
      outputs: [{
        verifier: { contract: Hash.digest(label), params: new Uint8Array(0) },
        value: 1,
        data: new Uint8Array(0),
      }],
      declaredWeight: 1,
      refs: [],
    },
    privateKey,
  );
  return { block, raw: packet.raw, publicKey };
}

// -- Tests ---------------------------------------------------------

Deno.test('StorageManager: restore loads and processes all stored packets', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, (b) => processed.push(b));

  const genesis = createGenesisBlock([]);
  const a = makeSignedPacket(genesis, 'block-a');
  const b = makeSignedPacket(genesis, 'block-b');
  const c = makeSignedPacket(genesis, 'block-c');

  await storage.save(a.block.hash.toHex(), a.raw);
  await storage.save(b.block.hash.toHex(), b.raw);
  await storage.save(c.block.hash.toHex(), c.raw);

  await manager.restore();

  assertEquals(processed.length, 3);
  const processedHexes = processed.map((b) => b.hash.toHex()).sort();
  const expected = [a, b, c].map((p) => p.block.hash.toHex()).sort();
  assertEquals(processedHexes, expected);
});

Deno.test('StorageManager: restore recovers signer cryptographically from packet bytes', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, (b) => processed.push(b));

  const genesis = createGenesisBlock([]);
  const { block, raw, publicKey } = makeSignedPacket(genesis, 'signed');
  await storage.save(block.hash.toHex(), raw);

  await manager.restore();

  assertEquals(processed.length, 1);
  assertEquals(processed[0].signer, publicKey);
});

Deno.test('StorageManager: restore returns count of successfully parsed packets', async () => {
  const storage = new MockStoragePlugin();
  const manager = new StorageManager(storage, () => {});

  const genesis = createGenesisBlock([]);
  const a = makeSignedPacket(genesis, 'a');
  const b = makeSignedPacket(genesis, 'b');

  await storage.save(a.block.hash.toHex(), a.raw);
  await storage.save(b.block.hash.toHex(), b.raw);

  assertEquals(await manager.restore(), 2);
});

Deno.test('StorageManager: restore skips unparseable bytes', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, (b) => processed.push(b));

  // Garbage bytes that are not a valid Scaffold packet.
  await storage.save('garbage', new Uint8Array([1, 2, 3, 4, 5]));

  assertEquals(await manager.restore(), 0);
  assertEquals(processed.length, 0);
});

Deno.test('StorageManager: onCanonical persists raw packet bytes', async () => {
  const storage = new MockStoragePlugin();
  const manager = new StorageManager(storage, () => {});

  const genesis = createGenesisBlock([]);
  const { block, raw } = makeSignedPacket(genesis, 'persist');

  await manager.onCanonical(block.hash, raw);

  assertEquals(storage.store.size, 1);
  assertEquals(storage.store.get(block.hash.toHex()), raw);
});

Deno.test('StorageManager: onNonCanonical removes a block', async () => {
  const storage = new MockStoragePlugin();
  const manager = new StorageManager(storage, () => {});

  const genesis = createGenesisBlock([]);
  const { block, raw } = makeSignedPacket(genesis, 'remove');
  await manager.onCanonical(block.hash, raw);
  assertEquals(storage.store.size, 1);

  await manager.onNonCanonical(block.hash);
  assertEquals(storage.store.size, 0);
});

Deno.test('StorageManager: restore with empty storage', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, (b) => processed.push(b));

  assertEquals(await manager.restore(), 0);
  assertEquals(processed.length, 0);
});

Deno.test('StorageManager: roundtrip preserves block fields and signer', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, (b) => processed.push(b));

  const genesis = createGenesisBlock([]);
  const { block: original, raw, publicKey } = makeSignedPacket(genesis, 'roundtrip');
  await manager.onCanonical(original.hash, raw);

  await manager.restore();

  assertEquals(processed.length, 1);
  const restored = processed[0];

  assertEquals(restored.hash.toHex(), original.hash.toHex());
  assertEquals(restored.declaredWeight, original.declaredWeight);
  assertEquals(restored.outputs.length, original.outputs.length);
  assertEquals(restored.anchor.toHex(), original.anchor.toHex());
  assertEquals(restored.signer, publicKey);
  assert(restored.signer !== undefined);
});
