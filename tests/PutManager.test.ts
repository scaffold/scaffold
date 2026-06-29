// PutManager: runs the contract generator for (contract, params) with
// `records` answering env.request({RECORD_CONTRACT, key}). Strict
// matching -- unmatched requests and unused records both reject.

import { assert, assertEquals, assertRejects } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../src/genesis.ts';
import { AGGREGATION_CONTRACT, Block, RECORD_CONTRACT } from '../src/core/Block.ts';
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

// -- env.put -> sub-generation -------------------------------------

const CHILD_CONTRACT = Hash.digest('scaffold:test:env-put-child');
const PARENT_CONTRACT = Hash.digest('scaffold:test:env-put-parent');

/**
 * Child of the env.put tests. Same shape as testContract above: params
 * encode newline-separated record keys, the contract requests each one
 * and emits an aggregation marker.
 */
const childContract: Contract = {
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

/**
 * Parent of the env.put tests. Calls env.put once with a fixed child
 * verifier and the records the caller (via PutManager.put) passes in
 * through `params.childKeys` and `params.childRecords`. Encodes records
 * with one key per line and a `key=value` shape.
 *
 * Parent itself emits only the aggregation marker.
 */
const parentContract: Contract = {
  outputNamespaces: [AGGREGATION_CONTRACT],
  async run(env) {
    const params = new TextDecoder().decode(env.params());
    const [childKeysLine, ...recordLines] = params.split('|');
    const records: Record<string, string> = {};
    for (const line of recordLines) {
      if (line === '') continue;
      const eq = line.indexOf('=');
      records[line.slice(0, eq)] = line.slice(eq + 1);
    }
    await env.put(
      { contract: CHILD_CONTRACT, params: str2bin(childKeysLine) },
      records,
    );
    env.send({ contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) }, 0);
  },
};

function makeNodeWithChild(): Scaffold {
  const node = makeNode();
  node.registerContract(CHILD_CONTRACT, childContract);
  node.registerContract(PARENT_CONTRACT, parentContract);
  return node;
}

Deno.test('env.put: parent contract spawns a child block carrying the records', async () => {
  const node = makeNodeWithChild();
  // Parent runs put({child, "foo\nbar"}, {foo: "1", bar: "2"}) then emits its
  // aggregation marker.
  const parentBlock = await node.put({
    contract: PARENT_CONTRACT,
    params: str2bin('foo\nbar|foo=1|bar=2'),
    records: {},
  });

  // The parent block exists and is canonical -- env.put is blocking, so
  // by the time PutManager resolves the parent block, the sub-block has
  // also committed.
  assert(node.context.consensus.isCanonical(parentBlock.hash));

  // Find the child block in the store via the child's verifier.
  let childBlock: Block | undefined;
  for (const b of node.context.store.values()) {
    if (
      b.outputs.some((o) =>
        Hash.equals(o.verifier.contract, CHILD_CONTRACT) ||
        (Hash.equals(o.verifier.contract, RECORD_CONTRACT) &&
          (new TextDecoder().decode(o.verifier.params) === 'foo' ||
            new TextDecoder().decode(o.verifier.params) === 'bar'))
      )
    ) {
      // The parent block only emits AGGREGATION; the child emits RECORD outputs.
      // We want the latter -- the one that actually claims a RECORD output.
      const hasRecord = b.outputs.some((o) => Hash.equals(o.verifier.contract, RECORD_CONTRACT));
      if (hasRecord) {
        childBlock = b;
        break;
      }
    }
  }
  assert(childBlock, 'expected a child block emitting RECORD outputs');

  const td = new TextDecoder();
  const recordOutputs = childBlock.outputs.filter((o) =>
    Hash.equals(o.verifier.contract, RECORD_CONTRACT)
  );
  assertEquals(recordOutputs.length, 2);
  const foo = recordOutputs.find((o) => td.decode(o.verifier.params) === 'foo');
  const bar = recordOutputs.find((o) => td.decode(o.verifier.params) === 'bar');
  assert(foo);
  assertEquals(td.decode(foo.body!), '1');
  assert(bar);
  assertEquals(td.decode(bar.body!), '2');

  await node.close();
});

Deno.test('env.put: sub-generator rejection cancels the parent draft', async () => {
  const node = makeNodeWithChild();
  // Child requests "foo" but parent supplies no records -- the sub-generator
  // throws ContractRejection on the unmatched request, env.put propagates,
  // and PutManager rejects the parent draft.
  await assertRejects(
    () =>
      node.put({
        contract: PARENT_CONTRACT,
        params: str2bin('foo|'),
        records: {},
      }),
    Error,
    'put draft cancelled',
  );
  await node.close();
});

// -- Data-based answers (put { data } -> getResult generation) -------
// Validates the new answer path end-to-end through generation: PutManager
// installs the `data` payload, the contract's getResult() commits it as a
// self-claimed answer under the running verifier, and BlockBuilderModule
// self-claims it via the 'answer' slot origin. See docs/protocol/results.md.

const ANSWER_CONTRACT = Hash.digest('scaffold:test:answer-contract');

const answerContract: Contract = {
  outputNamespaces: [ANSWER_CONTRACT, AGGREGATION_CONTRACT],
  async run(env) {
    // getResult commits the host-supplied payload as the answer under
    // {ANSWER_CONTRACT, params}. (A real contract would validate the bytes.)
    await env.getResult();
    env.send({ contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) }, 0);
  },
};

Deno.test('PutManager.put: data publishes a self-claimed answer via getResult', async () => {
  const node = makeNode();
  node.registerContract(ANSWER_CONTRACT, answerContract);

  const block = await node.put({
    contract: ANSWER_CONTRACT,
    params: str2bin('q'),
    data: str2bin('the answer'),
  });

  const td = new TextDecoder();
  const answer = block.outputs.find((o) =>
    Hash.equals(o.verifier.contract, ANSWER_CONTRACT) && td.decode(o.verifier.params) === 'q'
  );
  assert(answer, 'expected an answer output under {ANSWER_CONTRACT, q}');
  assertEquals(td.decode(answer.body!), 'the answer');
  assertEquals(answer.value, 0);

  // The answer is self-claimed: its own-output index is in the block's claims.
  const idx = block.outputs.indexOf(answer);
  assert(block.claimIndices.includes(idx), 'answer output must be self-claimed');

  assert(node.context.consensus.isCanonical(block.hash));
  await node.close();
});
