// PutManager: the narrow put({contract, params, records}) +
// send({contract, params, body}) surface. Both publish through the
// DraftManager bottleneck.

import { assert, assertEquals, assertExists } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../src/genesis.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { str2bin } from '../src/util/buffer.ts';

const TEST_VERIFIER_CONTRACT = Hash.digest('scaffold:test:put-verifier');

function makeNode(): Scaffold {
  return new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis: computeDemoGenesis(['a']),
    enableLogging: false,
    enablePiggyback: false,
    enableGeneration: () => false,
  });
}

function tipBlockFor(node: Scaffold, contract: Hash, params: Uint8Array) {
  for (const block of [...node.context.store.values()].reverse()) {
    if (
      block.outputs.some((o) =>
        Hash.equals(o.verifier.contract, contract) &&
        o.verifier.params.length === params.length &&
        o.verifier.params.every((b, i) => b === params[i])
      )
    ) {
      return block;
    }
  }
  return undefined;
}

Deno.test('PutManager.put: emits a verifier-marker output under (contract, params)', async () => {
  const node = makeNode();
  const params = str2bin('alpha');
  node.put({ contract: TEST_VERIFIER_CONTRACT, params, records: {} });
  const block = tipBlockFor(node, TEST_VERIFIER_CONTRACT, params);
  assertExists(block, 'block with verifier output should exist');
  await node.close();
});

Deno.test('PutManager.put: records become RECORD_CONTRACT outputs', async () => {
  const node = makeNode();
  const params = str2bin('alpha');
  node.put({
    contract: TEST_VERIFIER_CONTRACT,
    params,
    records: { foo: 'bar', baz: new Uint8Array([1, 2, 3]) },
  });
  const block = tipBlockFor(node, TEST_VERIFIER_CONTRACT, params);
  assertExists(block);
  const recordOutputs = block!.outputs.filter((o) =>
    Hash.equals(o.verifier.contract, RECORD_CONTRACT)
  );
  assertEquals(recordOutputs.length, 2);
  const foo = recordOutputs.find((o) => new TextDecoder().decode(o.verifier.params) === 'foo');
  const baz = recordOutputs.find((o) => new TextDecoder().decode(o.verifier.params) === 'baz');
  assertExists(foo);
  assertEquals(new TextDecoder().decode(foo!.body!), 'bar');
  assertExists(baz);
  assertEquals(baz!.body, new Uint8Array([1, 2, 3]));
  await node.close();
});

Deno.test('PutManager.send: emits a single output under the verifier', async () => {
  const node = makeNode();
  const params = str2bin('s1');
  const body = new Uint8Array([9, 8, 7]);
  node.send({ contract: TEST_VERIFIER_CONTRACT, params, body });
  const block = tipBlockFor(node, TEST_VERIFIER_CONTRACT, params);
  assertExists(block);
  const verifierOutput = block!.outputs.find((o) =>
    Hash.equals(o.verifier.contract, TEST_VERIFIER_CONTRACT)
  );
  assertExists(verifierOutput);
  assertEquals(verifierOutput!.body, body);
  assertEquals(verifierOutput!.value, 0);
  await node.close();
});

Deno.test('PutManager.send: value defaults to 0 and accepts explicit values', async () => {
  const node = makeNode();
  const params = str2bin('s2');
  node.send({ contract: TEST_VERIFIER_CONTRACT, params, body: new Uint8Array(0), value: 42 });
  const block = tipBlockFor(node, TEST_VERIFIER_CONTRACT, params);
  assertExists(block);
  const verifierOutput = block!.outputs.find((o) =>
    Hash.equals(o.verifier.contract, TEST_VERIFIER_CONTRACT)
  );
  assertExists(verifierOutput);
  assertEquals(verifierOutput!.value, 42);
  await node.close();
});

Deno.test('PutManager.put: the resulting block becomes canonical', async () => {
  const node = makeNode();
  node.put({
    contract: TEST_VERIFIER_CONTRACT,
    params: str2bin('canon'),
    records: { x: 'y' },
  });
  const block = tipBlockFor(node, TEST_VERIFIER_CONTRACT, str2bin('canon'));
  assertExists(block);
  assert(node.context.consensus.isCanonical(block!.hash));
  await node.close();
});
