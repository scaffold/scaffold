import { PacketType } from '../src/core/Packet.ts';
import { withNodeFields } from './testutil/blockNodeFields.ts';

import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { AtomSource, AtomType, Block, BlockStore } from '../src/core/Block.ts';
import { ReactiveEvent } from '../src/node/ReactiveLayer.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { ContractExecutor, ContractFn } from '../src/node/ContractExecutor.ts';
import { GenerationStrategy } from '../src/node/strategies/GenerationStrategy.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { ZERO_HASH } from '../src/util/Hash.ts';

// -- Test helpers ------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

/** Create a ContractExecutor with the given contract hashes registered. */
function makeExecutor(...contractNames: string[]): ContractExecutor {
  const contracts = new Map<string, ContractFn>();
  for (const name of contractNames) {
    const hash = h(name);
    contracts.set(hash.toPrimitive(), (_ctx) => {});
  }
  return new ContractExecutor(contracts);
}

/** Create a stub Block with the given hash and outputs. */
function stubBlock(blockHash: Hash, outputs: Output[] = []): Block {
  return withNodeFields({
    hash: blockHash,
    anchor: ZERO_HASH,
    aggregates: [],
    claimIndices: [],
    outputs,
    declaredWeight: 1,
    refs: [],
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

/** Create an output with the given contract hash. */
function makeOutput(contractName: string, value = 0): Output {
  return {
    verifier: { contract: h(contractName), params: new Uint8Array(0) },
    value,
    data: new Uint8Array(),
  };
}

/** Create a ReactiveEvent with canonicality changes and a populated store. */
function makeEvent(
  store: BlockStore,
  blockHash: Hash,
  canonicalityChanges: { hash: Hash; canonical: boolean }[],
): ReactiveEvent {
  const result: BlockReceivedResult = {
    canonicalityChanges,
    newConflicts: [],
  };
  return {
    block: store.get(blockHash) ?? stubBlock(blockHash),
    fromPeer: null,
    result,
    store,
    consensus: {} as ReactiveEvent['consensus'],
    sampling: {} as ReactiveEvent['sampling'],
  };
}

/** Set up a store with the given blocks. */
function makeStore(...blocks: Block[]): BlockStore {
  const store = new BlockStore();
  for (const b of blocks) {
    store.put(b);
  }
  return store;
}

// -- Tests -------------------------------------------------------

Deno.test('canonical incentive block triggers createBlock action', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor);

  const block = stubBlock(h('incentive'), [makeOutput('myContract', 10)]);
  const store = makeStore(block);
  const event = makeEvent(store, block.hash, [
    { hash: block.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'createBlock');
  if (actions[0].type === 'createBlock') {
    assertEquals(Hash.equals(actions[0].spec.anchor, block.hash), true);
    assertEquals(Hash.equals(actions[0].spec.outputs[0].verifier.contract, h('myContract')), true);
    assertEquals(actions[0].sign, true);
  }
});

Deno.test('unknown contract is ignored', () => {
  const executor = makeExecutor('knownContract');
  const strategy = new GenerationStrategy(executor);

  const block = stubBlock(h('other'), [makeOutput('unknownContract', 5)]);
  const store = makeStore(block);
  const event = makeEvent(store, block.hash, [
    { hash: block.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('inFlight prevents duplicate generation for same block', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor);

  const block = stubBlock(h('incentive'), [makeOutput('myContract', 10)]);
  const store = makeStore(block);

  // First evaluation triggers generation.
  const first = strategy.evaluate(
    makeEvent(store, block.hash, [{ hash: block.hash, canonical: true }]),
  );
  assertEquals(first.length, 1);

  // Second evaluation on same block should produce no actions.
  const second = strategy.evaluate(
    makeEvent(store, block.hash, [{ hash: block.hash, canonical: true }]),
  );
  assertEquals(second.length, 0);
});

Deno.test('maxConcurrent limit is respected', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor, { maxConcurrent: 2 });

  const blockA = stubBlock(h('A'), [makeOutput('myContract')]);
  const blockB = stubBlock(h('B'), [makeOutput('myContract')]);
  const blockC = stubBlock(h('C'), [makeOutput('myContract')]);
  const store = makeStore(blockA, blockB, blockC);

  const event = makeEvent(store, blockA.hash, [
    { hash: blockA.hash, canonical: true },
    { hash: blockB.hash, canonical: true },
    { hash: blockC.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 2);
  assertEquals(strategy.inFlightCount, 2);
});

Deno.test('completeGeneration frees a concurrency slot', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor, { maxConcurrent: 1 });

  const blockA = stubBlock(h('A'), [makeOutput('myContract')]);
  const blockB = stubBlock(h('B'), [makeOutput('myContract')]);
  const store = makeStore(blockA, blockB);

  // Fill the single slot with A.
  const first = strategy.evaluate(
    makeEvent(store, blockA.hash, [{ hash: blockA.hash, canonical: true }]),
  );
  assertEquals(first.length, 1);
  assertEquals(strategy.inFlightCount, 1);

  // Slot is full -- B cannot be generated.
  const blocked = strategy.evaluate(
    makeEvent(store, blockB.hash, [{ hash: blockB.hash, canonical: true }]),
  );
  assertEquals(blocked.length, 0);

  // Complete A's generation.
  strategy.completeGeneration(h('A'));
  assertEquals(strategy.inFlightCount, 0);

  // Now B can proceed.
  const after = strategy.evaluate(
    makeEvent(store, blockB.hash, [{ hash: blockB.hash, canonical: true }]),
  );
  assertEquals(after.length, 1);
  if (after[0].type === 'createBlock') {
    assertEquals(Hash.equals(after[0].spec.anchor, blockB.hash), true);
  }
});

Deno.test('no action when no canonicality changes', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor);

  const block = stubBlock(h('noChange'), [makeOutput('myContract')]);
  const store = makeStore(block);

  // Event with empty canonicality changes.
  const event = makeEvent(store, block.hash, []);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('no action when only non-canonical changes', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor);

  const block = stubBlock(h('decanonicalized'), [makeOutput('myContract')]);
  const store = makeStore(block);

  // Event with only canonical: false changes.
  const event = makeEvent(store, block.hash, [
    { hash: block.hash, canonical: false },
  ]);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('block with no outputs is ignored', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor);

  const block = stubBlock(h('empty'), []);
  const store = makeStore(block);
  const event = makeEvent(store, block.hash, [
    { hash: block.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('block not in store is skipped', () => {
  const executor = makeExecutor('myContract');
  const strategy = new GenerationStrategy(executor);

  // Empty store -- block not found.
  const store = new BlockStore();
  const event = makeEvent(store, h('missing'), [
    { hash: h('missing'), canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('multiple incentive blocks in one event each get actions', () => {
  const executor = makeExecutor('contractA', 'contractB');
  const strategy = new GenerationStrategy(executor);

  const blockA = stubBlock(h('incA'), [makeOutput('contractA')]);
  const blockB = stubBlock(h('incB'), [makeOutput('contractB')]);
  const store = makeStore(blockA, blockB);

  const event = makeEvent(store, blockA.hash, [
    { hash: blockA.hash, canonical: true },
    { hash: blockB.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 2);
  assertEquals(strategy.inFlightCount, 2);

  // Verify both are createBlock actions anchored on the correct blocks.
  for (const action of actions) {
    assertEquals(action.type, 'createBlock');
  }
});

Deno.test('uses first matching output contract', () => {
  const executor = makeExecutor('contractX');
  const strategy = new GenerationStrategy(executor);

  // Block has two outputs -- only the second matches.
  const block = stubBlock(h('multi'), [
    makeOutput('unknown'),
    makeOutput('contractX', 5),
  ]);
  const store = makeStore(block);
  const event = makeEvent(store, block.hash, [
    { hash: block.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  if (actions[0].type === 'createBlock') {
    assertEquals(
      Hash.equals(actions[0].spec.outputs[0].verifier.contract, h('contractX')),
      true,
    );
  }
});
