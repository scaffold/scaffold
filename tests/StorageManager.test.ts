import { assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Block } from '../src/core/Block.ts';
import { BlockSerializer, StorageManager, StoragePlugin } from '../src/node/StorageManager.ts';
import { deserialize, serialize } from '../src/core/BlockSerializer.ts';

// -- Mock storage plugin -------------------------------------------

class MockStoragePlugin implements StoragePlugin {
  readonly store = new Map<string, string>();

  loadAll(): Promise<Array<{ hash: string; data: string }>> {
    const entries: Array<{ hash: string; data: string }> = [];
    for (const [hash, data] of this.store) {
      entries.push({ hash, data });
    }
    return Promise.resolve(entries);
  }

  save(hash: string, data: string): Promise<void> {
    this.store.set(hash, data);
    return Promise.resolve();
  }

  remove(hash: string): Promise<void> {
    this.store.delete(hash);
    return Promise.resolve();
  }
}

// -- Test serializer using existing BlockSerializer ----------------

const testSerializer: BlockSerializer = {
  serialize(block: Block): string {
    return serialize(block);
  },
  deserialize(data: string): Block {
    return deserialize<Block>(data);
  },
};

// -- Helper to create a minimal valid Block ------------------------

function makeBlock(name: string): Block {
  const hash = Hash.digest(name);
  return {
    hash,
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
  };
}

// -- Tests ---------------------------------------------------------

Deno.test('StorageManager: restore loads and processes all stored blocks', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, testSerializer, (b) => processed.push(b));

  const block1 = makeBlock('block-1');
  const block2 = makeBlock('block-2');
  const block3 = makeBlock('block-3');

  // Pre-populate storage
  await storage.save(block1.hash.toHex(), testSerializer.serialize(block1));
  await storage.save(block2.hash.toHex(), testSerializer.serialize(block2));
  await storage.save(block3.hash.toHex(), testSerializer.serialize(block3));

  await manager.restore();

  assertEquals(processed.length, 3);

  const processedHexes = processed.map((b) => b.hash.toHex()).sort();
  const expectedHexes = [block1, block2, block3].map((b) => b.hash.toHex()).sort();
  assertEquals(processedHexes, expectedHexes);
});

Deno.test('StorageManager: restore returns correct count', async () => {
  const storage = new MockStoragePlugin();
  const manager = new StorageManager(storage, testSerializer, () => {});

  const block1 = makeBlock('a');
  const block2 = makeBlock('b');

  await storage.save(block1.hash.toHex(), testSerializer.serialize(block1));
  await storage.save(block2.hash.toHex(), testSerializer.serialize(block2));

  const count = await manager.restore();
  assertEquals(count, 2);
});

Deno.test('StorageManager: onCanonical persists a block', async () => {
  const storage = new MockStoragePlugin();
  const manager = new StorageManager(storage, testSerializer, () => {});

  const block = makeBlock('canonical-block');
  await manager.onCanonical(block);

  assertEquals(storage.store.size, 1);
  assertEquals(storage.store.has(block.hash.toHex()), true);

  const storedData = storage.store.get(block.hash.toHex())!;
  const restored = testSerializer.deserialize(storedData);
  assertEquals(restored.hash.toHex(), block.hash.toHex());
  assertEquals(restored.declaredWeight, block.declaredWeight);
});

Deno.test('StorageManager: onNonCanonical removes a block', async () => {
  const storage = new MockStoragePlugin();
  const manager = new StorageManager(storage, testSerializer, () => {});

  const block = makeBlock('to-remove');
  await manager.onCanonical(block);
  assertEquals(storage.store.size, 1);

  await manager.onNonCanonical(block.hash);
  assertEquals(storage.store.size, 0);
  assertEquals(storage.store.has(block.hash.toHex()), false);
});

Deno.test('StorageManager: restore with empty storage', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, testSerializer, (b) => processed.push(b));

  const count = await manager.restore();

  assertEquals(count, 0);
  assertEquals(processed.length, 0);
});

Deno.test('StorageManager: serialization roundtrip through save/restore', async () => {
  const storage = new MockStoragePlugin();
  const processed: Block[] = [];
  const manager = new StorageManager(storage, testSerializer, (b) => processed.push(b));

  const original = makeBlock('roundtrip');
  await manager.onCanonical(original);

  await manager.restore();

  assertEquals(processed.length, 1);
  const restored = processed[0];

  assertEquals(restored.hash.toHex(), original.hash.toHex());
  assertEquals(restored.declaredWeight, original.declaredWeight);
  assertEquals(restored.claims, original.claims);
  assertEquals(restored.outputs, original.outputs);
  assertEquals(restored.anchor, original.anchor);
});
