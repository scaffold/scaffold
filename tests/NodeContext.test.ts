import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Block } from '../src/core/Block.ts';
import { BitVector } from '../src/core/BitVector.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { NodeConfig, NodeContext } from '../src/node/NodeContext.ts';
import { Action, ReactiveEvent, Strategy } from '../src/node/ReactiveLayer.ts';

// -- Helpers --------------------------------------------------------

function makeOutput(value: number, label?: string): Output {
  return {
    contract: Hash.digest(label ?? 'contract'),
    value,
    data: new Uint8Array([]),
  };
}

/** Create a simple leaf block anchored to the given parent. */
function makeLeafBlock(
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
): Block {
  const anchorOutputCount = anchor.outputCount;
  const claimMask = BitVector.empty(anchorOutputCount);
  const outputCount = anchorOutputCount + outputs.length;

  const hashParts: Uint8Array[] = [
    anchor.hash.toBytes(),
    new Uint8Array(new Float64Array([declaredWeight]).buffer),
    new Uint8Array(new Float64Array([Math.random()]).buffer),
  ];
  for (const out of outputs) {
    hashParts.push(out.contract.toBytes());
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
  }
  const hash = Hash.digestParts(...hashParts);

  return {
    hash,
    anchor: anchor.hash,
    aggregates: [],
    claimMask,
    subtreeClaimMask: null,
    ownOutputCount: outputs.length,
    outputCount,
    anchorOutputCount,
    aggregateOutputCounts: [],
    claims: [],
    outputs,
    declaredWeight,
    weightVector: [declaredWeight],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };
}

function defaultConfig(): NodeConfig {
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

Deno.test('NodeContext: initializes with genesis block in store', () => {
  const ctx = new NodeContext(defaultConfig());

  // Genesis hash should be available
  const genesisHash = ctx.genesisHash;
  assert(genesisHash);

  // Genesis block should be in the store
  const genesis = ctx.store.get(genesisHash);
  assert(genesis);
  assertEquals(genesis.outputs.length, 2);
  assertEquals(genesis.outputs[0].value, 100);
  assertEquals(genesis.outputs[1].value, 200);
});

Deno.test('NodeContext: genesis block is canonical', () => {
  const ctx = new NodeContext(defaultConfig());
  assert(ctx.consensus.isCanonical(ctx.genesisHash));
});

Deno.test('NodeContext: processBlock processes through reactive layer', () => {
  const ctx = new NodeContext(defaultConfig());

  const genesis = ctx.store.get(ctx.genesisHash)!;
  const block = makeLeafBlock(genesis, [makeOutput(50, 'new')], 10);

  ctx.processBlock(block);

  // Block should be in the store
  assert(ctx.store.has(block.hash));

  // Block should be canonical (no conflicts)
  assert(ctx.consensus.isCanonical(block.hash));
});

Deno.test('NodeContext: strategies receive events on processBlock', () => {
  const events: ReactiveEvent[] = [];

  const strategy: Strategy = {
    evaluate(event: ReactiveEvent): Action[] {
      events.push(event);
      return [];
    },
  };

  const ctx = new NodeContext({
    ...defaultConfig(),
    strategies: [strategy],
  });

  const genesis = ctx.store.get(ctx.genesisHash)!;
  const block = makeLeafBlock(genesis, [makeOutput(50, 'new')], 10);

  ctx.processBlock(block);

  assertEquals(events.length, 1);
  assertEquals(events[0].block.hash.toPrimitive(), block.hash.toPrimitive());
  assertEquals(events[0].fromPeer, null);
});

Deno.test('NodeContext: strategies do NOT fire on genesis block', () => {
  const events: ReactiveEvent[] = [];

  const strategy: Strategy = {
    evaluate(event: ReactiveEvent): Action[] {
      events.push(event);
      return [];
    },
  };

  // Strategy is registered before genesis is processed (in constructor).
  // Genesis should NOT trigger the strategy.
  const _ctx = new NodeContext({
    ...defaultConfig(),
    strategies: [strategy],
  });

  assertEquals(events.length, 0);
});

Deno.test('NodeContext: strategies receive fromPeer when provided', () => {
  const events: ReactiveEvent[] = [];

  const strategy: Strategy = {
    evaluate(event: ReactiveEvent): Action[] {
      events.push(event);
      return [];
    },
  };

  const ctx = new NodeContext({
    ...defaultConfig(),
    strategies: [strategy],
  });

  const genesis = ctx.store.get(ctx.genesisHash)!;
  const block = makeLeafBlock(genesis, [makeOutput(50, 'new')], 10);

  ctx.processBlock(block, 'peer-42');

  assertEquals(events.length, 1);
  assertEquals(events[0].fromPeer, 'peer-42');
});

Deno.test('NodeContext: service accessors return working instances', () => {
  const ctx = new NodeContext(defaultConfig());

  // All service accessors should return defined instances
  assert(ctx.consensus);
  assert(ctx.conflict);
  assert(ctx.sampling);
  assert(ctx.gossip);
  assert(ctx.trust);
  assert(ctx.blockCreation);
  assert(ctx.coordinator);
  assert(ctx.store);
  assert(ctx.reactiveLayer);

  // Consensus should be functional: genesis is canonical
  assert(ctx.consensus.isCanonical(ctx.genesisHash));
});

Deno.test('NodeContext: multiple strategies all receive events', () => {
  const eventsA: ReactiveEvent[] = [];
  const eventsB: ReactiveEvent[] = [];

  const strategyA: Strategy = {
    evaluate(event: ReactiveEvent): Action[] {
      eventsA.push(event);
      return [];
    },
  };
  const strategyB: Strategy = {
    evaluate(event: ReactiveEvent): Action[] {
      eventsB.push(event);
      return [];
    },
  };

  const ctx = new NodeContext({
    ...defaultConfig(),
    strategies: [strategyA, strategyB],
  });

  const genesis = ctx.store.get(ctx.genesisHash)!;
  const block = makeLeafBlock(genesis, [makeOutput(50, 'new')], 10);

  ctx.processBlock(block);

  assertEquals(eventsA.length, 1);
  assertEquals(eventsB.length, 1);
  assertEquals(
    eventsA[0].block.hash.toPrimitive(),
    eventsB[0].block.hash.toPrimitive(),
  );
});

Deno.test('NodeContext: processBlock result includes canonicality changes', () => {
  const lastEvent: { event?: ReactiveEvent } = {};

  const strategy: Strategy = {
    evaluate(event: ReactiveEvent): Action[] {
      lastEvent.event = event;
      return [];
    },
  };

  const ctx = new NodeContext({
    ...defaultConfig(),
    strategies: [strategy],
  });

  const genesis = ctx.store.get(ctx.genesisHash)!;
  const block = makeLeafBlock(genesis, [makeOutput(50, 'new')], 10);

  ctx.processBlock(block);

  assert(lastEvent.event);
  // The result should contain the coordinator's full BlockReceivedResult
  assert(lastEvent.event.result);
  assert(Array.isArray(lastEvent.event.result.canonicalityChanges));
  assert(Array.isArray(lastEvent.event.result.pushActions));
  assert(Array.isArray(lastEvent.event.result.newConflicts));
});
