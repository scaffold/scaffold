import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { AGGREGATION_CONTRACT, Block } from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { composeGenesisPacket } from '../src/core/Packet.ts';
import { Scaffold, ScaffoldConfig } from '../src/Scaffold.ts';
import { NodeContext } from '../src/node/NodeContext.ts';
import { WELL_KNOWN_PRIVATE_KEY } from '../src/genesis.ts';

// -- Helpers --------------------------------------------------------

function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    detail: new Uint8Array([]),
  };
}

function defaultConfig(): ScaffoldConfig {
  const outputs = [makeOutput(100, 'g0'), makeOutput(200, 'g1')];
  const { block: genesis } = composeGenesisPacket(outputs);
  return { genesis };
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
      verifier: { contract: contractHash, params },
      value: 0,
      detail: new Uint8Array(0),
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

Deno.test('Scaffold: 4 sequential puts trigger aggregation block', async () => {
  // Mirrors the demo UI: click "Add Block" 4 times sequentially.
  // Each block anchors to the canonical tip (the previous block).
  // Non-zero output values force UTXO claims (autoBalance), which is what
  // the demo does (Math.floor(Math.random() * 100)).
  // After 4 blocks, the aggregation contract should fire and produce
  // an aggregation block that rolls up the 4 marker outputs.
  const scaffold = new Scaffold({ privateKey: WELL_KNOWN_PRIVATE_KEY });
  const ctx = scaffold.context;

  for (let i = 0; i < 4; i++) {
    scaffold.put({
      outputs: [makeOutput(50, `demo-${i}`)],
    });
  }

  // The aggregation contract resolves via async requireInput() --
  // flush microtasks to let it complete.
  await new Promise((r) => setTimeout(r, 50));

  // Look for a block carrying an aggregation data output (non-empty detail
  // on AGGREGATION_CONTRACT).
  let aggBlock: Block | undefined;
  for (const block of ctx.store.values()) {
    const hasAggData = block.outputs.some(
      (o) => Hash.equals(o.verifier.contract, AGGREGATION_CONTRACT) && o.detail.length > 0,
    );
    if (hasAggData) {
      aggBlock = block;
      break;
    }
  }

  assert(aggBlock, 'an aggregation block should have been created after 4 sequential puts');

  // The aggregation block should aggregate the chain blocks
  assert(aggBlock.aggregates.length > 0, 'aggregation block should have aggregates');
});
