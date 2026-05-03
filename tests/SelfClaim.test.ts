import { PacketType } from '../src/core/Packet.ts';
import { withNodeFields } from './testutil/blockNodeFields.ts';

import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BlockStore,
  getRefOutputs,
  RECORD_CONTRACT,
} from '../src/core/Block.ts';
import {
  findRecordOutput,
  getRecordKey,
  isRecordOutput,
  makeRecordOutput,
} from '../src/contracts/RecordContract.ts';
import { Output } from '../src/core/BlockCreationModule.ts';

// -- Helpers --------------------------------------------------------

function makeBlock(outputs: Output[], refs: Hash[] = []): Block {
  const hashParts = outputs.map((o) => o.verifier.contract.toBytes());
  hashParts.push(new Uint8Array(new Float64Array([Math.random()]).buffer));
  return withNodeFields({
    hash: Hash.digestParts(...hashParts),
    anchor: ZERO_HASH,
    aggregates: [],
    claimIndices: [],
    outputs,
    declaredWeight: 1,
    refs,
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
  });
}

// -- Tests ----------------------------------------------------------

Deno.test('makeRecordOutput produces correct verifier with string key', () => {
  const output = makeRecordOutput('state', new Uint8Array([1, 2, 3]));

  assert(Hash.equals(output.verifier.contract, RECORD_CONTRACT));
  assertEquals(output.verifier.params, new TextEncoder().encode('state'));
  assertEquals(output.value, 0);
  assertEquals(output.data, new Uint8Array([1, 2, 3]));
});

Deno.test('makeRecordOutput produces correct verifier with Uint8Array key', () => {
  const key = new Uint8Array([10, 20, 30]);
  const output = makeRecordOutput(key, new Uint8Array([4, 5]));

  assert(Hash.equals(output.verifier.contract, RECORD_CONTRACT));
  assertEquals(output.verifier.params, key);
  assertEquals(output.data, new Uint8Array([4, 5]));
});

Deno.test('isRecordOutput returns true for self-claimed outputs', () => {
  const output = makeRecordOutput('key', new Uint8Array(0));
  assert(isRecordOutput(output));
});

Deno.test('isRecordOutput returns false for non-self-claimed outputs', () => {
  const output: Output = {
    verifier: { contract: Hash.digest('other-contract'), params: new Uint8Array(0) },
    value: 42,
    data: new Uint8Array(0),
  };
  assertFalse(isRecordOutput(output));
});

Deno.test('getRecordKey returns the params from a self-claimed output', () => {
  const output = makeRecordOutput('myKey', new Uint8Array(0));
  const key = getRecordKey(output);
  assertEquals(key, new TextEncoder().encode('myKey'));
});

Deno.test('findRecordOutput finds by string key', () => {
  const target = makeRecordOutput('state', new Uint8Array([1]));
  const other = makeRecordOutput('counter', new Uint8Array([2]));
  const nonSelf: Output = {
    verifier: { contract: Hash.digest('x'), params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  };
  const block = makeBlock([nonSelf, target, other]);

  const found = findRecordOutput(block, 'state');
  assert(found !== undefined);
  assertEquals(found!.data, new Uint8Array([1]));
});

Deno.test('findRecordOutput finds by Uint8Array key', () => {
  const key = new Uint8Array([7, 8, 9]);
  const target = makeRecordOutput(key, new Uint8Array([42]));
  const block = makeBlock([target]);

  const found = findRecordOutput(block, key);
  assert(found !== undefined);
  assertEquals(found!.data, new Uint8Array([42]));
});

Deno.test('findRecordOutput returns undefined when key not found', () => {
  const output = makeRecordOutput('state', new Uint8Array([1]));
  const block = makeBlock([output]);

  const found = findRecordOutput(block, 'missing');
  assertEquals(found, undefined);
});

Deno.test('findRecordOutput returns undefined for empty block', () => {
  const block = makeBlock([]);
  assertEquals(findRecordOutput(block, 'key'), undefined);
});

Deno.test('self-claimed outputs have value=0', () => {
  const output = makeRecordOutput('k', new Uint8Array(0));
  assertEquals(output.value, 0);
});

Deno.test('getRefOutputs returns referenced block outputs', () => {
  const store = new BlockStore();

  const refOutput = makeRecordOutput('state', new Uint8Array([10]));
  const refBlock = makeBlock([refOutput]);
  store.put(refBlock);

  const block = makeBlock([], [refBlock.hash]);

  const outputs = getRefOutputs(block, 0, store);
  assert(outputs !== undefined);
  assertEquals(outputs!.length, 1);
  assertEquals(outputs![0].data, new Uint8Array([10]));
});

Deno.test('getRefOutputs returns undefined for out-of-bounds index', () => {
  const store = new BlockStore();
  const block = makeBlock([], []);

  assertEquals(getRefOutputs(block, 0, store), undefined);
  assertEquals(getRefOutputs(block, -1, store), undefined);
});

Deno.test('getRefOutputs returns undefined when referenced block not in store', () => {
  const store = new BlockStore();
  const block = makeBlock([], [Hash.random()]);

  assertEquals(getRefOutputs(block, 0, store), undefined);
});

Deno.test('getRefOutputs with multiple refs returns correct block', () => {
  const store = new BlockStore();

  const refBlock0 = makeBlock([makeRecordOutput('a', new Uint8Array([1]))]);
  const refBlock1 = makeBlock([makeRecordOutput('b', new Uint8Array([2]))]);
  store.put(refBlock0);
  store.put(refBlock1);

  const block = makeBlock([], [refBlock0.hash, refBlock1.hash]);

  const outputs0 = getRefOutputs(block, 0, store);
  assert(outputs0 !== undefined);
  assertEquals(outputs0![0].data, new Uint8Array([1]));

  const outputs1 = getRefOutputs(block, 1, store);
  assert(outputs1 !== undefined);
  assertEquals(outputs1![0].data, new Uint8Array([2]));
});
