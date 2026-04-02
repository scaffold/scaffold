import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Block, BlockSource, BlockStore } from '../src/core/Block.ts';
import { FetchResult, ReactiveEvent, VerifierKey } from '../src/node/ReactiveLayer.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { FetchNotifyStrategy } from '../src/node/strategies/FetchNotifyStrategy.ts';
import { FetchManager, Verifier } from '../src/node/FetchManager.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { ZERO_HASH } from '../src/util/Hash.ts';

// -- Test helpers ------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

/** Create an Output with a given contract name and params string. */
function makeOutput(contractName: string, dataStr: string): Output {
  const encoded = new TextEncoder().encode(dataStr);
  return {
    verifier: { contract: h(contractName), params: encoded },
    value: 0,
    detail: encoded,
  };
}

/** Build a Verifier from an Output (verifier.contract -> contractHash, verifier.params -> params). */
function outputVerifier(output: Output): Verifier {
  return { contractHash: output.verifier.contract, params: output.verifier.params };
}

/** Create a minimal Block with the given hash and outputs. */
function stubBlock(blockHash: Hash, outputs: Output[]): Block {
  return {
    hash: blockHash,
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs,
    declaredWeight: 1,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  } satisfies Block;
}

/** Create a BlockStore pre-loaded with the given blocks. */
function makeStore(blocks: Block[]): BlockStore {
  const store = new BlockStore();
  for (const b of blocks) {
    store.put(b);
  }
  return store;
}

/** Create a ReactiveEvent with the given store and canonicality changes. */
function makeEvent(
  store: BlockStore,
  triggerBlock: Block,
  canonicalityChanges: { hash: Hash; canonical: boolean }[],
): ReactiveEvent {
  const result: BlockReceivedResult = {
    pushActions: [],
    canonicalityChanges,
    newConflicts: [],
  };
  return {
    block: triggerBlock,
    fromPeer: null,
    result,
    store,
    consensus: {} as ReactiveEvent['consensus'],
    sampling: {} as ReactiveEvent['sampling'],
  };
}

// -- Tests -------------------------------------------------------

Deno.test('canonical block matching a subscription triggers notifyFetch', () => {
  const output = makeOutput('myContract', 'hello');
  const block = stubBlock(h('block-A'), [output]);
  const store = makeStore([block]);

  const fetchManager = new FetchManager();
  const verifier = outputVerifier(output);
  const key = FetchManager.verifierKey(verifier);
  fetchManager.fetch(verifier, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block, [{ hash: block.hash, canonical: true }]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'notifyFetch');
  if (actions[0].type === 'notifyFetch') {
    assertEquals(actions[0].verifier, key);
    assertEquals(actions[0].result !== null, true);
    assertEquals((actions[0].result as FetchResult).data, output.detail);
  }
});

Deno.test('losing canonicality sends null', () => {
  const output = makeOutput('myContract', 'hello');
  const block = stubBlock(h('block-A'), [output]);
  const store = makeStore([block]);

  const fetchManager = new FetchManager();
  const verifier = outputVerifier(output);
  const key = FetchManager.verifierKey(verifier);
  fetchManager.fetch(verifier, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block, [{ hash: block.hash, canonical: false }]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'notifyFetch');
  if (actions[0].type === 'notifyFetch') {
    assertEquals(actions[0].verifier, key);
    assertEquals(actions[0].result, null);
  }
});

Deno.test('blocks not matching any subscription are ignored', () => {
  const output = makeOutput('myContract', 'hello');
  const block = stubBlock(h('block-A'), [output]);
  const store = makeStore([block]);

  // FetchManager has no subscriptions
  const fetchManager = new FetchManager();

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block, [{ hash: block.hash, canonical: true }]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('multiple outputs generate multiple notifications', () => {
  const output1 = makeOutput('contractA', 'data-1');
  const output2 = makeOutput('contractB', 'data-2');
  const block = stubBlock(h('block-multi'), [output1, output2]);
  const store = makeStore([block]);

  const fetchManager = new FetchManager();
  const verifier1 = outputVerifier(output1);
  const verifier2 = outputVerifier(output2);
  const key1 = FetchManager.verifierKey(verifier1);
  const key2 = FetchManager.verifierKey(verifier2);
  fetchManager.fetch(verifier1, { onResult: () => {} });
  fetchManager.fetch(verifier2, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block, [{ hash: block.hash, canonical: true }]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 2);

  // Both should be notifyFetch with their respective keys
  const verifiers = actions
    .filter((a): a is Extract<typeof a, { type: 'notifyFetch' }> => a.type === 'notifyFetch')
    .map((a) => a.verifier);
  assertEquals(verifiers.includes(key1), true);
  assertEquals(verifiers.includes(key2), true);

  // Both should carry the data (canonical = true)
  for (const action of actions) {
    if (action.type === 'notifyFetch') {
      assertEquals(action.result !== null, true);
    }
  }
});

Deno.test('no notifications when no canonicality changes', () => {
  const output = makeOutput('myContract', 'hello');
  const block = stubBlock(h('block-A'), [output]);
  const store = makeStore([block]);

  const fetchManager = new FetchManager();
  const verifier = outputVerifier(output);
  fetchManager.fetch(verifier, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  // Empty canonicality changes
  const event = makeEvent(store, block, []);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('block not found in store is silently skipped', () => {
  const output = makeOutput('myContract', 'hello');
  const block = stubBlock(h('block-A'), [output]);
  // Store does NOT contain the block
  const store = new BlockStore();

  const fetchManager = new FetchManager();
  const verifier = outputVerifier(output);
  fetchManager.fetch(verifier, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block, [{ hash: block.hash, canonical: true }]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('only outputs matching subscriptions produce actions', () => {
  const output1 = makeOutput('contractA', 'subscribed');
  const output2 = makeOutput('contractB', 'not-subscribed');
  const block = stubBlock(h('block-partial'), [output1, output2]);
  const store = makeStore([block]);

  const fetchManager = new FetchManager();
  // Only subscribe to the first output
  const verifier1 = outputVerifier(output1);
  const key1 = FetchManager.verifierKey(verifier1);
  fetchManager.fetch(verifier1, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block, [{ hash: block.hash, canonical: true }]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  if (actions[0].type === 'notifyFetch') {
    assertEquals(actions[0].verifier, key1);
  }
});

Deno.test('multiple canonicality changes across different blocks', () => {
  const output1 = makeOutput('contractA', 'data-1');
  const output2 = makeOutput('contractB', 'data-2');
  const block1 = stubBlock(h('block-1'), [output1]);
  const block2 = stubBlock(h('block-2'), [output2]);
  const store = makeStore([block1, block2]);

  const fetchManager = new FetchManager();
  const v1 = outputVerifier(output1);
  const v2 = outputVerifier(output2);
  const key1 = FetchManager.verifierKey(v1);
  const key2 = FetchManager.verifierKey(v2);
  fetchManager.fetch(v1, { onResult: () => {} });
  fetchManager.fetch(v2, { onResult: () => {} });

  const strategy = new FetchNotifyStrategy(fetchManager);
  const event = makeEvent(store, block1, [
    { hash: block1.hash, canonical: true },
    { hash: block2.hash, canonical: false },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 2);

  // block1 became canonical => result with data
  const a1 = actions.find(
    (a) => a.type === 'notifyFetch' && a.verifier === key1,
  );
  assertEquals(a1 !== undefined, true);
  if (a1 && a1.type === 'notifyFetch') {
    assertEquals(a1.result !== null, true);
    assertEquals((a1.result as FetchResult).data, output1.detail);
  }

  // block2 lost canonicality => result is null
  const a2 = actions.find(
    (a) => a.type === 'notifyFetch' && a.verifier === key2,
  );
  assertEquals(a2 !== undefined, true);
  if (a2 && a2.type === 'notifyFetch') {
    assertEquals(a2.result, null);
  }
});
