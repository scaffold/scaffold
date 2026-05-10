// PutManager rewritten around DraftManager. These tests exercise the
// new draft-based put path end-to-end through Scaffold.

import { assert, assertEquals, assertExists } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../src/genesis.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import { str2bin } from '../src/util/buffer.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';

function makeRecordOutput(key: string, value: string): Output {
  return {
    verifier: { contract: RECORD_CONTRACT, params: str2bin(key) },
    value: 0,
    body: str2bin(value),
  };
}

function makeNode(): Scaffold {
  return new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis: computeDemoGenesis(['a']),
    enableLogging: false,
    enablePiggyback: false,
    enableGeneration: () => false,
  });
}

Deno.test('PutManager: basic put with outputs creates a canonical block', async () => {
  const node = makeNode();
  const result = node.put({ outputs: [makeRecordOutput('greeting', 'hello')] });
  assertExists(result.block);
  assertExists(result.hash);
  assert(node.context.consensus.isCanonical(result.hash!));
  await node.close();
});

Deno.test('PutManager: records are converted to RECORD_CONTRACT outputs', async () => {
  const node = makeNode();
  const result = node.put({ records: { foo: 'bar' } });
  assertExists(result.block);
  const recordOutputs = result.block!.outputs.filter((o) =>
    o.verifier.contract.toHex() === RECORD_CONTRACT.toHex()
  );
  assertEquals(recordOutputs.length, 1);
  await node.close();
});

Deno.test('PutManager: explicit declaredWeight propagates to the block', async () => {
  const node = makeNode();
  const result = node.put({
    outputs: [makeRecordOutput('k', 'v')],
    declaredWeight: 42,
  });
  assertExists(result.block);
  assertEquals(result.block!.declaredWeight, 42);
  await node.close();
});

Deno.test('PutManager: default declaredWeight is 1', async () => {
  const node = makeNode();
  const result = node.put({ outputs: [makeRecordOutput('k', 'v')] });
  assertExists(result.block);
  assertEquals(result.block!.declaredWeight, 1);
  await node.close();
});

Deno.test('PutManager: claims against producer outputs resolve correctly', async () => {
  const node = makeNode();
  const result = node.put({
    outputs: [makeSignatureOutput(node.publicKey, 1_000_000)],
    claims: [{ producer: node.context.genesisHash, outputIndex: 0 }],
  });
  assertExists(result.block);
  assert(node.context.consensus.isCanonical(result.hash!));
  await node.close();
});

Deno.test('PutManager: publish:false parks the draft without producing a block', async () => {
  const node = makeNode();
  const result = node.put({
    key: 'my-key',
    outputs: [makeRecordOutput('k', 'v')],
    publish: false,
  });
  assertEquals(result.block, null);
  assertEquals(result.hash, null);
  const draft = node.context.draftStore.get(result.draftId);
  assertExists(draft);
  assertEquals(draft!.status.phase, 'ready');
  await node.close();
});

Deno.test('PutManager: repeated puts with same key extend the parked draft', async () => {
  const node = makeNode();
  const first = node.put({
    key: 'k1',
    outputs: [makeRecordOutput('a', '1')],
    publish: false,
  });
  const second = node.put({
    key: 'k1',
    outputs: [makeRecordOutput('b', '2')],
    publish: false,
  });
  assertEquals(first.draftId.toHex(), second.draftId.toHex());
  const draft = node.context.draftStore.get(first.draftId);
  assertExists(draft);
  const recordOutputs = draft!.outputs.filter((o) =>
    o.verifier.contract.toHex() === RECORD_CONTRACT.toHex()
  );
  assertEquals(recordOutputs.length, 2);
  await node.close();
});

Deno.test('PutManager: keyed put with publish:true evicts the key', async () => {
  const node = makeNode();
  const first = node.put({
    key: 'k2',
    outputs: [makeRecordOutput('a', '1')],
    publish: true,
  });
  assertExists(first.block);
  const second = node.put({
    key: 'k2',
    outputs: [makeRecordOutput('b', '2')],
    publish: false,
  });
  assert(first.draftId.toHex() !== second.draftId.toHex(), 'keys evicted on publish');
  await node.close();
});
