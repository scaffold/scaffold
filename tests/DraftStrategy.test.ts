import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Block, BlockSource, BlockStore, SIGNATURE_CONTRACT } from '../src/core/Block.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { ProbeService } from '../src/core/ProbeService.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { ReactiveEvent } from '../src/node/ReactiveLayer.ts';
import { CreateDraftAction, DraftStrategy } from '../src/node/strategies/DraftStrategy.ts';

// -- Helpers ------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

function makeBlock(hash: Hash, anchor: Hash, outputs: Block['outputs'] = []): Block {
  return {
    hash,
    anchor,
    aggregates: [],
    claims: [],
    outputs,
    declaredWeight: 1,
    refs: [],
    timestamp: Date.now(),
    receivedAt: Date.now(),
    source: BlockSource.Local,
  };
}

function makeEvent(
  block: Block,
  canonicalityChanges: { hash: Hash; canonical: boolean }[],
  store: BlockStore,
  consensus: ConsensusService,
): ReactiveEvent {
  const ctx = new ProtocolContext();
  return {
    block,
    fromPeer: null,
    result: {
      pushActions: [],
      canonicalityChanges,
      newConflicts: [],
    },
    store,
    consensus,
    probe: ctx.get(ProbeService),
  };
}

function setupWithBlocks() {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const consensus = ctx.get(ConsensusService);

  const genesis = makeBlock(h('genesis'), ZERO_HASH);
  store.put(genesis);
  consensus.addBlock(genesis.hash);

  return { store, consensus, genesis, ctx };
}

// -- Tests --------------------------------------------------------

Deno.test('DraftStrategy: newly canonical block with high-value output emits createDraft', () => {
  const { store, consensus, genesis } = setupWithBlocks();

  const block = makeBlock(h('block1'), genesis.hash, [
    {
      verifier: { contract: SIGNATURE_CONTRACT, params: new Uint8Array(33) },
      value: 100,
      data: new Uint8Array(0),
    },
  ]);
  store.put(block);
  consensus.addBlock(block.hash);
  consensus.setVerifiedWeight(block.hash, [1]);

  const strategy = new DraftStrategy({ minValue: 10 });
  const event = makeEvent(block, [{ hash: block.hash, canonical: true }], store, consensus);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  const action = actions[0] as CreateDraftAction;
  assertEquals(action.type, 'createDraft');
  assertEquals(action.claim.value, 100);
  assertEquals(action.claim.outputIndex, 0);
  assert(Hash.equals(action.claim.block, block.hash));
});

Deno.test('DraftStrategy: output below minValue produces no action', () => {
  const { store, consensus, genesis } = setupWithBlocks();

  const block = makeBlock(h('block2'), genesis.hash, [
    {
      verifier: { contract: SIGNATURE_CONTRACT, params: new Uint8Array(33) },
      value: 5,
      data: new Uint8Array(0),
    },
  ]);
  store.put(block);
  consensus.addBlock(block.hash);

  const strategy = new DraftStrategy({ minValue: 10 });
  const event = makeEvent(block, [{ hash: block.hash, canonical: true }], store, consensus);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('DraftStrategy: output already in-flight produces no duplicate', () => {
  const { store, consensus, genesis } = setupWithBlocks();

  const block = makeBlock(h('block3'), genesis.hash, [
    {
      verifier: { contract: SIGNATURE_CONTRACT, params: new Uint8Array(33) },
      value: 100,
      data: new Uint8Array(0),
    },
  ]);
  store.put(block);
  consensus.addBlock(block.hash);
  consensus.setVerifiedWeight(block.hash, [1]);

  const strategy = new DraftStrategy({ minValue: 1 });
  const event = makeEvent(block, [{ hash: block.hash, canonical: true }], store, consensus);

  // First call produces action
  const actions1 = strategy.evaluate(event);
  assertEquals(actions1.length, 1);

  // Second call -- same block canonical again -- no duplicate
  const actions2 = strategy.evaluate(event);
  assertEquals(actions2.length, 0);
});

Deno.test('DraftStrategy: multiple high-value outputs produce multiple actions (up to limit)', () => {
  const { store, consensus, genesis } = setupWithBlocks();

  const outputs = Array.from({ length: 5 }, (_, i) => ({
    verifier: { contract: SIGNATURE_CONTRACT, params: new Uint8Array(33) },
    value: 50 + i,
    data: new Uint8Array(0),
  }));

  const block = makeBlock(h('block4'), genesis.hash, outputs);
  store.put(block);
  consensus.addBlock(block.hash);
  consensus.setVerifiedWeight(block.hash, [1]);

  const strategy = new DraftStrategy({ minValue: 1, maxConcurrent: 3 });
  const event = makeEvent(block, [{ hash: block.hash, canonical: true }], store, consensus);
  const actions = strategy.evaluate(event);

  // Capped at maxConcurrent
  assertEquals(actions.length, 3);
});

Deno.test('DraftStrategy: non-canonical change produces no action', () => {
  const { store, consensus, genesis } = setupWithBlocks();

  const block = makeBlock(h('block5'), genesis.hash, [
    {
      verifier: { contract: SIGNATURE_CONTRACT, params: new Uint8Array(33) },
      value: 100,
      data: new Uint8Array(0),
    },
  ]);
  store.put(block);

  const strategy = new DraftStrategy({ minValue: 1 });
  const event = makeEvent(
    block,
    [{ hash: block.hash, canonical: false }],
    store,
    consensus,
  );
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});
