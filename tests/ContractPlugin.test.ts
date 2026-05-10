import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Contract } from '../src/contracts/Contract.ts';
import { ContractHost } from '../src/core/ContractHost.ts';
import type { ContractPlugin } from '../src/core/ContractPlugin.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';

// Lightweight stand-in block. ContractHost is generic over BlockType,
// so the unit tests don't need the full `Block` shape.
interface TestBlock {
  hash: Hash;
  marker?: string;
}

function makeContract(name: string): Contract {
  return {
    run: () => {/* no-op; identity tracked via reference */},
    // Stash the name on a unique property so assertions can identify it.
    outputNamespaces: [Hash.digest(`namespace:${name}`)],
  };
}

const h = (s: string) => Hash.digest(s);

Deno.test('ContractHost: registered TS contract wins over plugins', () => {
  const tsContract = makeContract('ts');
  const plugin: ContractPlugin<TestBlock> = {
    accepts: () => true,
    getContract: () => makeContract('plugin'),
  };
  const blockHash = h('block-A');
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: blockHash }),
  });
  host.registerContract(blockHash, tsContract);
  host.registerPlugin(plugin);

  assertEquals(host.getContract(blockHash), tsContract);
});

Deno.test('ContractHost: plugin resolves when TS registry misses', () => {
  const expected = makeContract('wasm-ish');
  const plugin: ContractPlugin<TestBlock> = {
    accepts: () => true,
    getContract: () => expected,
  };
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: h('any') }),
  });
  host.registerPlugin(plugin);

  assertEquals(host.getContract(h('any')), expected);
});

Deno.test('ContractHost: first-accepting plugin wins (registration order)', () => {
  const firstContract = makeContract('first');
  const secondContract = makeContract('second');
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: h('x'), marker: 'second' }),
  });
  // First plugin only accepts blocks marker='first'; this block's marker is 'second'.
  host.registerPlugin({
    accepts: (block) => block.marker === 'first',
    getContract: () => firstContract,
  });
  host.registerPlugin({
    accepts: (block) => block.marker === 'second',
    getContract: () => secondContract,
  });

  assertEquals(host.getContract(h('x')), secondContract);
});

Deno.test('ContractHost: plugin result is cached per hash', () => {
  let calls = 0;
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: h('cached') }),
  });
  host.registerPlugin({
    accepts: () => true,
    getContract: () => {
      calls++;
      return makeContract(`call-${calls}`);
    },
  });

  const first = host.getContract(h('cached'));
  const second = host.getContract(h('cached'));
  assertEquals(first, second);
  assertEquals(calls, 1);
});

Deno.test('ContractHost: registerPlugin invalidates cache', () => {
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: h('q') }),
  });
  const pluginA: ContractPlugin<TestBlock> = {
    accepts: () => false,
    getContract: () => makeContract('A'),
  };
  host.registerPlugin(pluginA);
  // First lookup: no plugin accepts -> undefined.
  assertEquals(host.getContract(h('q')), undefined);

  // Register a new plugin that accepts -- the prior negative result must
  // not be sticky.
  const expected = makeContract('B');
  host.registerPlugin({
    accepts: () => true,
    getContract: () => expected,
  });
  assertEquals(host.getContract(h('q')), expected);
});

Deno.test('ContractHost: no plugins + no getBlock -> undefined', () => {
  const host = new ContractHost<TestBlock>();
  assertEquals(host.getContract(h('any')), undefined);
});

Deno.test('ContractHost: getBlock miss falls through', () => {
  const plugin: ContractPlugin<TestBlock> = {
    accepts: () => true,
    getContract: () => makeContract('unreached'),
  };
  const host = new ContractHost<TestBlock>({
    getBlock: () => undefined,
  });
  host.registerPlugin(plugin);
  assertEquals(host.getContract(h('missing')), undefined);
});

Deno.test('ContractHost: getOutputNamespaces honors plugin-resolved contracts', () => {
  const ns = h('produced');
  const contract: Contract = { run: () => {}, outputNamespaces: [ns] };
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: h('blk') }),
  });
  host.registerPlugin({
    accepts: () => true,
    getContract: () => contract,
  });
  const got = host.getOutputNamespaces(h('blk'));
  assertEquals(got.length, 1);
  assertEquals(got[0].toHex(), ns.toHex());
});

Deno.test('ContractHost: runVerifying uses plugin-resolved contract', async () => {
  let ran = false;
  const contract: Contract = {
    run: (env) => {
      assertEquals(env.mode, ExecutionMode.Verification);
      ran = true;
    },
  };
  const blockHash = h('plugin-block');
  const host = new ContractHost<TestBlock>({
    getBlock: () => ({ hash: blockHash }),
  });
  host.registerPlugin({
    accepts: () => true,
    getContract: () => contract,
  });

  const result = await host.runVerifying(
    {
      block: { hash: blockHash } as TestBlock,
      verifier: { contract: blockHash, params: new Uint8Array(0) },
      outputs: [],
      claimIndices: [],
      refs: [],
      timestamp: 0,
    },
    {
      getBlock: () => undefined,
      getOutputs: () => [],
      getClaims: () => [],
      getRefs: () => [],
      resolveClaim: () => undefined,
    },
  );
  assertEquals(result.accepted, true);
  assertEquals(ran, true);
});
