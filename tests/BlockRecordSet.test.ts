import { PacketType } from '../src/core/Packet.ts';
import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { AtomSource, AtomType, Block } from '../src/core/Block.ts';
import { BlockRecordSet } from '../src/reactive/BlockRecordSet.ts';

// -- Helpers -------------------------------------------------------

function makeBlock(name: string): Block {
  return {
    hash: Hash.digest(name),
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
    timestamp: 100,
    receivedAt: 200,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    source: AtomSource.Local,
  };
}

// -- Tests ---------------------------------------------------------

Deno.test('BlockRecordSet: add() makes block appear in getAll()', () => {
  const set = new BlockRecordSet({ debounceMs: 0 });
  const block = makeBlock('test');

  set.add(block);

  const all = [...set.getAll()];
  assertEquals(all.length, 1);
  assertEquals(all[0].hash.toHex(), block.hash.toHex());
  set.dispose();
});

Deno.test('BlockRecordSet: get() retrieves block by hash', () => {
  const set = new BlockRecordSet({ debounceMs: 0 });
  const block = makeBlock('test');

  set.add(block);

  const retrieved = set.get(block.hash);
  assert(retrieved);
  assertEquals(retrieved!.hash.toHex(), block.hash.toHex());
  set.dispose();
});

Deno.test('BlockRecordSet: add() fires add listener', () => {
  const set = new BlockRecordSet({ debounceMs: 0 });
  const block = makeBlock('test');

  const added: Block[] = [];
  set.onAdd((b) => added.push(b));

  set.add(block);

  assertEquals(added.length, 1);
  assertEquals(added[0].hash.toHex(), block.hash.toHex());
  set.dispose();
});

Deno.test('BlockRecordSet: duplicate add is no-op', () => {
  const set = new BlockRecordSet({ debounceMs: 0 });
  const block = makeBlock('test');

  const added: Block[] = [];
  set.onAdd((b) => added.push(b));

  set.add(block);
  set.add(block); // duplicate

  assertEquals(added.length, 1);
  assertEquals([...set.getAll()].length, 1);
  set.dispose();
});

Deno.test('BlockRecordSet: notifyChanged() fires per-block update listener', () => {
  const set = new BlockRecordSet({ debounceMs: 0 });
  const blockA = makeBlock('A');
  const blockB = makeBlock('B');

  set.add(blockA);
  set.add(blockB);

  const updatesA: Block[] = [];
  const updatesB: Block[] = [];
  set.onUpdate(blockA, (b) => updatesA.push(b));
  set.onUpdate(blockB, (b) => updatesB.push(b));

  set.notifyChanged(blockA);

  assertEquals(updatesA.length, 1);
  assertEquals(updatesB.length, 0);
  set.dispose();
});

Deno.test('BlockRecordSet: block metadata (receivedAt, source) accessible', () => {
  const set = new BlockRecordSet({ debounceMs: 0 });
  const block = makeBlock('test');

  set.add(block);

  const retrieved = set.get(block.hash)!;
  assertEquals(retrieved.timestamp, 100);
  assertEquals(retrieved.receivedAt, 200);
  assertEquals(retrieved.source, AtomSource.Local);
  set.dispose();
});
