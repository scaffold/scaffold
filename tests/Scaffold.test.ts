import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { Scaffold, ScaffoldConfig } from '../src/Scaffold.ts';
import { NodeContext } from '../src/node/NodeContext.ts';

// -- Helpers --------------------------------------------------------

function makeOutput(value: number, label?: string): Output {
  return {
    contract: Hash.digest(label ?? 'contract'),
    value,
    data: new Uint8Array([]),
  };
}

function defaultConfig(): ScaffoldConfig {
  return {
    genesis: {
      outputs: [
        makeOutput(100, 'g0'),
        makeOutput(200, 'g1'),
      ],
    },
  };
}

// -- Tests ----------------------------------------------------------

Deno.test('Scaffold: constructs with genesis config', () => {
  const scaffold = new Scaffold(defaultConfig());
  assert(scaffold);
});

Deno.test('Scaffold: genesis block is in store after construction', () => {
  const scaffold = new Scaffold(defaultConfig());
  const ctx = scaffold.context;

  const genesisHash = ctx.genesisHash;
  assert(genesisHash);

  const genesis = ctx.store.get(genesisHash);
  assert(genesis);
  assertEquals(genesis.outputs.length, 2);
  assertEquals(genesis.outputs[0].value, 100);
  assertEquals(genesis.outputs[1].value, 200);
});

Deno.test('Scaffold: genesis block is canonical after construction', () => {
  const scaffold = new Scaffold(defaultConfig());
  const ctx = scaffold.context;
  assert(ctx.consensus.isCanonical(ctx.genesisHash));
});

Deno.test('Scaffold: context getter returns NodeContext', () => {
  const scaffold = new Scaffold(defaultConfig());
  assert(scaffold.context instanceof NodeContext);
});

Deno.test('Scaffold: put() creates and processes a block', () => {
  const scaffold = new Scaffold(defaultConfig());
  const ctx = scaffold.context;
  const genesis = ctx.store.get(ctx.genesisHash)!;

  // Put creates a block anchored to genesis. We need throughput-balanced
  // outputs (value 0 with no claims means balanced: inputs 0 = outputs 0).
  const result = scaffold.put({
    outputs: [makeOutput(0, 'new-output')],
  });

  assert(result);
  assert(result.hash);
  assert(result.block);

  // The block should be in the store after put
  assert(ctx.store.has(result.hash));

  // The block should be canonical (no conflicts)
  assert(ctx.consensus.isCanonical(result.hash));
});

Deno.test('Scaffold: fetch() returns a handle with close()', () => {
  const scaffold = new Scaffold(defaultConfig());

  const results: unknown[] = [];
  const handle = scaffold.fetch(
    { contractHash: Hash.digest('test-contract'), params: new Uint8Array([1, 2, 3]) },
    { onResult: (result) => results.push(result) },
  );

  assert(handle);
  assert(typeof handle.close === 'function');

  // Close should not throw
  handle.close();
});

Deno.test('Scaffold: fetch() notifies when matching block becomes canonical', () => {
  const scaffold = new Scaffold(defaultConfig());

  const contractHash = Hash.digest('fetch-contract');
  const params = new Uint8Array([10, 20]);

  const results: unknown[] = [];
  const handle = scaffold.fetch(
    { contractHash, params },
    { onResult: (result) => results.push(result) },
  );

  // Put a block whose output matches the verifier (contract + params as data)
  scaffold.put({
    outputs: [{
      contract: contractHash,
      value: 0,
      data: params,
    }],
  });

  // The FetchNotifyStrategy should have noticed the canonical block and notified
  assertEquals(results.length, 1);
  assert(results[0] !== null);

  handle.close();
});

Deno.test('Scaffold: close() does not throw', async () => {
  const scaffold = new Scaffold(defaultConfig());
  await scaffold.close();
});
