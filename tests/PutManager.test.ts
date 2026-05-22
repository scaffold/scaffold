// PutManager: runs the contract generator for (contract, params) with
// `records` answering env.request({RECORD_CONTRACT, key}). Strict
// matching -- unmatched requests and unused records both reject.

import { assert, assertEquals, assertRejects } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../src/genesis.ts';
import { AGGREGATION_CONTRACT, RECORD_CONTRACT } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { str2bin } from '../src/util/buffer.ts';
import type { Contract } from '../src/contracts/Contract.ts';

const TEST_CONTRACT = Hash.digest('scaffold:test:records-consuming-contract');

/**
 * Test contract: params encode a newline-separated list of expected
 * record keys. The contract calls env.request for each key. It also
 * emits an aggregation marker so the resulting block is structurally
 * complete (the BlockBuilder's invariants expect one per non-genesis
 * block; without it the block fails to solidify).
 */
const testContract: Contract = {
  outputNamespaces: [RECORD_CONTRACT, AGGREGATION_CONTRACT],
  async run(env) {
    const keysStr = new TextDecoder().decode(env.params());
    const keys = keysStr === '' ? [] : keysStr.split('\n');
    for (const key of keys) {
      await env.request({
        contract: RECORD_CONTRACT,
        params: str2bin(key),
      });
    }
    env.send({ contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) }, 0);
  },
};

function makeNode(): Scaffold {
  const node = new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis: computeDemoGenesis(['a']),
    enableLogging: false,
    enablePiggyback: false,
    enableGeneration: () => false,
  });
  node.registerContract(TEST_CONTRACT, testContract);
  return node;
}

Deno.test('PutManager.put: resolves with a block carrying the requested records', async () => {
  const node = makeNode();
  const block = await node.put({
    contract: TEST_CONTRACT,
    params: str2bin('foo\nbaz'),
    records: { foo: 'bar', baz: new Uint8Array([1, 2, 3]) },
  });
  const recordOutputs = block.outputs.filter((o) =>
    Hash.equals(o.verifier.contract, RECORD_CONTRACT)
  );
  assertEquals(recordOutputs.length, 2);
  const foo = recordOutputs.find((o) => new TextDecoder().decode(o.verifier.params) === 'foo');
  const baz = recordOutputs.find((o) => new TextDecoder().decode(o.verifier.params) === 'baz');
  assert(foo);
  assertEquals(new TextDecoder().decode(foo.body!), 'bar');
  assert(baz);
  assertEquals(baz.body, new Uint8Array([1, 2, 3]));
  assert(node.context.consensus.isCanonical(block.hash));
  await node.close();
});

Deno.test('PutManager.put: empty records works when the contract requests nothing', async () => {
  const node = makeNode();
  const block = await node.put({
    contract: TEST_CONTRACT,
    params: str2bin(''),
    records: {},
  });
  assert(block);
  // Only the aggregation marker should be on the block.
  const recordOutputs = block.outputs.filter((o) =>
    Hash.equals(o.verifier.contract, RECORD_CONTRACT)
  );
  assertEquals(recordOutputs.length, 0);
  await node.close();
});

Deno.test('PutManager.put: unmatched request rejects the Promise', async () => {
  const node = makeNode();
  // Contract requests 'foo' and 'bar' but records only supplies 'foo'.
  await assertRejects(
    () =>
      node.put({
        contract: TEST_CONTRACT,
        params: str2bin('foo\nbar'),
        records: { foo: 'x' },
      }),
    Error,
    'put draft cancelled',
  );
  await node.close();
});

Deno.test('PutManager.put: unused records reject the Promise', async () => {
  const node = makeNode();
  // Contract requests only 'foo' but records supplies 'foo' and 'extra'.
  await assertRejects(
    () =>
      node.put({
        contract: TEST_CONTRACT,
        params: str2bin('foo'),
        records: { foo: 'x', extra: 'y' },
      }),
    Error,
    'unused records',
  );
  await node.close();
});

Deno.test('PutManager.put: unregistered contract rejects synchronously', async () => {
  const node = makeNode();
  const unknown = Hash.digest('scaffold:test:not-a-real-contract');
  await assertRejects(
    () =>
      node.put({
        contract: unknown,
        params: new Uint8Array(0),
        records: {},
      }),
    Error,
    'no contract registered',
  );
  await node.close();
});
