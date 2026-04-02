import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import {
  Block,
  BlockSource,
  BlockStore,
  createSelfClaimedOutput,
  findResultOutput,
  getRefOutputs,
  getResultKey,
  isResultOutput,
  RESULT_CONTRACT,
} from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';

// -- Helpers --------------------------------------------------------

function makeBlock(outputs: Output[], refs: Hash[] = []): Block {
  const hashParts = outputs.map((o) => o.verifier.contract.toBytes());
  hashParts.push(new Uint8Array(new Float64Array([Math.random()]).buffer));
  return {
    hash: Hash.digestParts(...hashParts),
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs,
    declaredWeight: 1,
    refs,
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
}

// -- Tests ----------------------------------------------------------

Deno.test('createSelfClaimedOutput produces correct verifier with string key', () => {
  const output = createSelfClaimedOutput('state', new Uint8Array([1, 2, 3]));

  assert(Hash.equals(output.verifier.contract, RESULT_CONTRACT));
  assertEquals(output.verifier.params, new TextEncoder().encode('state'));
  assertEquals(output.value, 0);
  assertEquals(output.data, new Uint8Array([1, 2, 3]));
});

Deno.test('createSelfClaimedOutput produces correct verifier with Uint8Array key', () => {
  const key = new Uint8Array([10, 20, 30]);
  const output = createSelfClaimedOutput(key, new Uint8Array([4, 5]));

  assert(Hash.equals(output.verifier.contract, RESULT_CONTRACT));
  assertEquals(output.verifier.params, key);
  assertEquals(output.data, new Uint8Array([4, 5]));
});

Deno.test('isResultOutput returns true for self-claimed outputs', () => {
  const output = createSelfClaimedOutput('key', new Uint8Array(0));
  assert(isResultOutput(output));
});

Deno.test('isResultOutput returns false for non-self-claimed outputs', () => {
  const output: Output = {
    verifier: { contract: Hash.digest('other-contract'), params: new Uint8Array(0) },
    value: 42,
    data: new Uint8Array(0),
  };
  assertFalse(isResultOutput(output));
});

Deno.test('getResultKey returns the params from a self-claimed output', () => {
  const output = createSelfClaimedOutput('myKey', new Uint8Array(0));
  const key = getResultKey(output);
  assertEquals(key, new TextEncoder().encode('myKey'));
});

Deno.test('findResultOutput finds by string key', () => {
  const target = createSelfClaimedOutput('state', new Uint8Array([1]));
  const other = createSelfClaimedOutput('counter', new Uint8Array([2]));
  const nonSelf: Output = {
    verifier: { contract: Hash.digest('x'), params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  };
  const block = makeBlock([nonSelf, target, other]);

  const found = findResultOutput(block, 'state');
  assert(found !== undefined);
  assertEquals(found!.data, new Uint8Array([1]));
});

Deno.test('findResultOutput finds by Uint8Array key', () => {
  const key = new Uint8Array([7, 8, 9]);
  const target = createSelfClaimedOutput(key, new Uint8Array([42]));
  const block = makeBlock([target]);

  const found = findResultOutput(block, key);
  assert(found !== undefined);
  assertEquals(found!.data, new Uint8Array([42]));
});

Deno.test('findResultOutput returns undefined when key not found', () => {
  const output = createSelfClaimedOutput('state', new Uint8Array([1]));
  const block = makeBlock([output]);

  const found = findResultOutput(block, 'missing');
  assertEquals(found, undefined);
});

Deno.test('findResultOutput returns undefined for empty block', () => {
  const block = makeBlock([]);
  assertEquals(findResultOutput(block, 'key'), undefined);
});

Deno.test('self-claimed outputs have value=0', () => {
  const output = createSelfClaimedOutput('k', new Uint8Array(0));
  assertEquals(output.value, 0);
});

Deno.test('getRefOutputs returns referenced block outputs', () => {
  const store = new BlockStore();

  const refOutput = createSelfClaimedOutput('state', new Uint8Array([10]));
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

  const refBlock0 = makeBlock([createSelfClaimedOutput('a', new Uint8Array([1]))]);
  const refBlock1 = makeBlock([createSelfClaimedOutput('b', new Uint8Array([2]))]);
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
