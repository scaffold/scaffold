import { PacketType } from '../src/core/Packet.ts';

import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { AtomSource, AtomType, Block, BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { BlockSpec, Output } from '../src/core/BlockCreationModule.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { SamplingService } from '../src/core/SamplingService.ts';
import { TrustService } from '../src/core/TrustService.ts';
import { BlockCreationService } from '../src/core/BlockCreationService.ts';
import { Coordinator } from '../src/core/Coordinator.ts';
import {
  Action,
  BlockCreator,
  ReactiveEvent,
  ReactiveLayer,
  Strategy,
} from '../src/node/ReactiveLayer.ts';

// -- Helpers --------------------------------------------------------

function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    data: new Uint8Array([]),
  };
}

function makeLeafBlock(
  name: string,
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
): Block {
  const hash = Hash.digest(name);

  return {
    hash,
    anchor: anchor.hash,
    aggregates: [],
    claimIndices: [],
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
  };
}

/** Create a full protocol stack and return the pieces needed for ReactiveLayer. */
function setupStack() {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const consensus = ctx.get(ConsensusService);
  const sampling = ctx.get(SamplingService);
  ctx.get(TrustService);
  ctx.get(BlockCreationService);
  const coordinator = ctx.get(Coordinator);

  return { ctx, store, coordinator, consensus, sampling };
}

/** A mock strategy that records every event it receives and returns configured actions. */
class RecordingStrategy implements Strategy {
  readonly calls: ReactiveEvent[] = [];
  actionsToReturn: Action[] = [];

  evaluate(event: ReactiveEvent): Action[] {
    this.calls.push(event);
    return this.actionsToReturn;
  }
}

/** A strategy that returns actions only on the first call. */
class OnceStrategy implements Strategy {
  readonly calls: ReactiveEvent[] = [];
  private fired = false;
  actionsOnFirst: Action[] = [];

  evaluate(event: ReactiveEvent): Action[] {
    this.calls.push(event);
    if (!this.fired) {
      this.fired = true;
      return this.actionsOnFirst;
    }
    return [];
  }
}

/** A mock block creator that records calls and returns pre-configured blocks. */
class MockBlockCreator implements BlockCreator {
  readonly calls: { spec: BlockSpec; privateKey: Uint8Array | null }[] = [];
  private blocksToReturn: (Block | null)[] = [];

  queueBlock(block: Block | null): void {
    this.blocksToReturn.push(block);
  }

  createBlock(spec: BlockSpec, privateKey: Uint8Array | null): Block | null {
    this.calls.push({ spec, privateKey });
    return this.blocksToReturn.shift() ?? null;
  }
}

// -- Tests ----------------------------------------------------------

Deno.test('ReactiveLayer: passes block through coordinator and strategies', () => {
  const { store, coordinator, consensus, sampling } = setupStack();
  const strategy = new RecordingStrategy();
  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  layer.processBlock(genesis, null);

  // Strategy should have been called once
  assertEquals(strategy.calls.length, 1);

  // The event should contain the genesis block
  const event = strategy.calls[0];
  assertEquals(event.block.hash.toPrimitive(), genesis.hash.toPrimitive());
  assertEquals(event.fromPeer, null);

  // Block should be in the store (coordinator stored it)
  assert(store.has(genesis.hash));
});

Deno.test('ReactiveLayer: passes fromPeer to event', () => {
  const { store, coordinator, consensus, sampling } = setupStack();
  const strategy = new RecordingStrategy();
  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  layer.processBlock(genesis, 'peer-42');

  assertEquals(strategy.calls[0].fromPeer, 'peer-42');
});

Deno.test('ReactiveLayer: collects actions from multiple strategies', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const strategy1 = new RecordingStrategy();
  strategy1.actionsToReturn = [
    {
      type: 'verify',
      block: Hash.digest('b1'),
      contract: Hash.digest('c1'),
      params: new Uint8Array([1]),
    },
  ];

  const strategy2 = new RecordingStrategy();
  strategy2.actionsToReturn = [
    { type: 'dispute', block: Hash.digest('b2'), side: 'for' },
    { type: 'dispute', block: Hash.digest('b3'), side: 'against' },
  ];

  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy1, strategy2],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  const result = layer.processBlock(genesis, null);

  // Should have collected all 3 actions
  assertEquals(result.actions.length, 3);
  assertEquals(result.actions[0].type, 'verify');
  assertEquals(result.actions[1].type, 'dispute');
  assertEquals(result.actions[2].type, 'dispute');
});

Deno.test('ReactiveLayer: createBlock action triggers recursion', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);

  // The child block that the creator will return
  const childBlock = makeLeafBlock('child', genesis, [makeOutput(50, 'child-out')], 10);

  const strategy = new OnceStrategy();
  strategy.actionsOnFirst = [
    {
      type: 'createBlock',
      spec: {
        anchor: genesis.hash,
        outputs: [makeOutput(50, 'child-out')],
        claims: [],
        declaredWeight: 10,
        aggregates: [],
        refs: [],
      },
      sign: true,
    },
  ];

  const creator = new MockBlockCreator();
  creator.queueBlock(childBlock);

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const result = layer.processBlock(genesis, null);

  // Creator should have been called once (for the createBlock action)
  assertEquals(creator.calls.length, 1);
  // sign=true but no privateKey on layer → null passed
  assertEquals(creator.calls[0].privateKey, null);

  // Both genesis and child should be in store
  assert(store.has(genesis.hash));
  assert(store.has(childBlock.hash));

  // The result should include the createBlock action
  assertEquals(result.actions.filter((a) => a.type === 'createBlock').length, 1);
});

Deno.test('ReactiveLayer: recursion guard prevents strategies from evaluating cycle-created blocks', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  const childBlock = makeLeafBlock('guarded-child', genesis, [makeOutput(50, 'c-out')], 10);

  // This strategy always wants to create a block.
  // Without the guard, it would create blocks forever.
  const strategy = new RecordingStrategy();
  strategy.actionsToReturn = [
    {
      type: 'createBlock',
      spec: {
        anchor: genesis.hash,
        outputs: [makeOutput(50, 'c-out')],
        claims: [],
        declaredWeight: 10,
        aggregates: [],
        refs: [],
      },
      sign: false,
    },
  ];

  const creator = new MockBlockCreator();
  // The creator returns a block for the first call, then null for subsequent
  creator.queueBlock(childBlock);

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  layer.processBlock(genesis, null);

  // Strategy should have been called once for the genesis block.
  // The child block was created in-cycle, so the strategy should NOT
  // be re-evaluated for it (recursion guard skips strategy evaluation).
  assertEquals(strategy.calls.length, 1);
  assertEquals(strategy.calls[0].block.hash.toPrimitive(), genesis.hash.toPrimitive());

  // But the child block should still be in the store (coordinator processed it)
  assert(store.has(childBlock.hash));
});

Deno.test('ReactiveLayer: createBlock action with null return from creator does not recurse', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);

  const strategy = new OnceStrategy();
  strategy.actionsOnFirst = [
    {
      type: 'createBlock',
      spec: {
        anchor: genesis.hash,
        outputs: [],
        claims: [],
        declaredWeight: 0,
        aggregates: [],
        refs: [],
      },
      sign: false,
    },
  ];

  const creator = new MockBlockCreator();
  // Creator returns null (block creation failed)
  creator.queueBlock(null);

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const result = layer.processBlock(genesis, null);

  // Creator was called
  assertEquals(creator.calls.length, 1);

  // Strategy was called only once (for genesis)
  assertEquals(strategy.calls.length, 1);

  // The action is still collected
  assertEquals(result.actions.length, 1);
  assertEquals(result.actions[0].type, 'createBlock');
});

Deno.test('ReactiveLayer: event exposes coordinator result', () => {
  const { store, coordinator, consensus, sampling } = setupStack();
  const strategy = new RecordingStrategy();
  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  layer.processBlock(genesis, null);

  // The event should have a result with the expected shape
  const event = strategy.calls[0];
  assert(event.result !== undefined);
  assert(Array.isArray(event.result.canonicalityChanges));
  assert(Array.isArray(event.result.newConflicts));
});

Deno.test('ReactiveLayer: event exposes services', () => {
  const { store, coordinator, consensus, sampling } = setupStack();
  const strategy = new RecordingStrategy();
  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  layer.processBlock(genesis, null);

  const event = strategy.calls[0];
  assert(event.store === store);
  assert(event.consensus === consensus);
  assert(event.sampling === sampling);
});

Deno.test('ReactiveLayer: no strategies means no actions', () => {
  const { store, coordinator, consensus, sampling } = setupStack();
  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  const result = layer.processBlock(genesis, null);

  assertEquals(result.actions.length, 0);
  assert(store.has(genesis.hash));
});

Deno.test('ReactiveLayer: multiple createBlock actions in one evaluation', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  const child1 = makeLeafBlock('multi-child1', genesis, [makeOutput(30, 'c1')], 5);
  const child2 = makeLeafBlock('multi-child2', genesis, [makeOutput(20, 'c2')], 3);

  const strategy = new OnceStrategy();
  strategy.actionsOnFirst = [
    {
      type: 'createBlock',
      spec: {
        anchor: genesis.hash,
        outputs: [makeOutput(30, 'c1')],
        claims: [],
        declaredWeight: 5,
        aggregates: [],
        refs: [],
      },
      sign: true,
    },
    {
      type: 'createBlock',
      spec: {
        anchor: genesis.hash,
        outputs: [makeOutput(20, 'c2')],
        claims: [],
        declaredWeight: 3,
        aggregates: [],
        refs: [],
      },
      sign: false,
    },
  ];

  const creator = new MockBlockCreator();
  creator.queueBlock(child1);
  creator.queueBlock(child2);

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const result = layer.processBlock(genesis, null);

  // Both children should be created
  assertEquals(creator.calls.length, 2);

  // All blocks should be in the store
  assert(store.has(genesis.hash));
  assert(store.has(child1.hash));
  assert(store.has(child2.hash));

  // Both createBlock actions should be collected
  assertEquals(result.actions.filter((a) => a.type === 'createBlock').length, 2);
});

Deno.test('ReactiveLayer: recursive block creation with chained strategies', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  const child = makeLeafBlock('chain-child', genesis, [makeOutput(50, 'ch')], 10);
  const grandchild = makeLeafBlock('chain-grandchild', child, [makeOutput(25, 'gc')], 5);

  // Strategy 1 creates child on genesis, strategy 2 creates grandchild on child.
  // But since child is cycle-created, strategy 2 won't fire for it.
  // We need a strategy that fires on genesis to create both.
  const strategy = new RecordingStrategy();
  strategy.actionsToReturn = [
    {
      type: 'createBlock',
      spec: {
        anchor: genesis.hash,
        outputs: [makeOutput(50, 'ch')],
        claims: [],
        declaredWeight: 10,
        aggregates: [],
        refs: [],
      },
      sign: false,
    },
  ];

  const creator = new MockBlockCreator();
  creator.queueBlock(child);
  // No more blocks queued, so second createBlock from recursion returns null

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  layer.processBlock(genesis, null);

  // Strategy should be called exactly once (for genesis).
  // The child block is cycle-created, so strategies are skipped for it.
  assertEquals(strategy.calls.length, 1);

  // Both blocks in store
  assert(store.has(genesis.hash));
  assert(store.has(child.hash));
});

Deno.test('ReactiveLayer: non-createBlock actions do not trigger block creator', () => {
  const { store, coordinator, consensus, sampling } = setupStack();

  const strategy = new RecordingStrategy();
  strategy.actionsToReturn = [
    {
      type: 'verify',
      block: Hash.digest('v1'),
      contract: Hash.digest('c1'),
      params: new Uint8Array([]),
    },
    { type: 'dispute', block: Hash.digest('d1'), side: 'for' },
  ];

  const creator = new MockBlockCreator();

  const layer = new ReactiveLayer({
    coordinator,
    store,
    consensus,
    sampling,
    strategies: [strategy],
    blockCreator: creator,
  });

  const genesis = createGenesisBlock([makeOutput(100, 'out0')]);
  const result = layer.processBlock(genesis, null);

  // Creator should NOT have been called
  assertEquals(creator.calls.length, 0);

  assertEquals(result.actions.length, 2);
});
