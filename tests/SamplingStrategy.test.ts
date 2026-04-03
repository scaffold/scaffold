import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { Block, BlockStore } from '../src/core/Block.ts';
import { ProbeModule, ProbeProvider } from '../src/core/ProbeModule.ts';
import { ReactiveEvent } from '../src/node/ReactiveLayer.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { SamplingStrategy } from '../src/node/strategies/SamplingStrategy.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  aggregates: Hash[];
  selfWeight: number;
  subtreeWeight: number;
}

class TestProvider implements ProbeProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  getHash(block: TestBlock): Hash {
    return block.hash;
  }

  getAggregates(block: TestBlock): Hash[] {
    return block.aggregates;
  }

  getSelfWeight(block: TestBlock): number {
    return block.selfWeight;
  }

  getAggregateWeights(block: TestBlock): number[] {
    return block.aggregates.map((aggHash) => {
      const agg = this.blocks.get(aggHash.toPrimitive());
      return agg ? agg.subtreeWeight : 0;
    });
  }
}

const h = (name: string): Hash => Hash.digest(name);

function block(name: string, weight: number): TestBlock {
  return { hash: h(name), aggregates: [], selfWeight: weight, subtreeWeight: weight };
}

function setupProbe(...blocks: TestBlock[]): ProbeModule<TestBlock> {
  const provider = new TestProvider();
  const module = new ProbeModule<TestBlock>(provider);
  for (const b of blocks) {
    provider.add(b);
    module.addBlock(b.hash);
  }
  return module;
}

function stubBlock(blockHash: Hash): Block {
  return { hash: blockHash } as unknown as Block;
}

function makeEvent(
  probe: ProbeModule<TestBlock>,
  blockHash: Hash,
  canonicalityChanges: { hash: Hash; canonical: boolean }[],
): ReactiveEvent {
  const result: BlockReceivedResult = {
    pushActions: [],
    canonicalityChanges,
    newConflicts: [],
  };
  return {
    block: stubBlock(blockHash),
    fromPeer: null,
    result,
    store: new BlockStore(),
    consensus: {} as ReactiveEvent['consensus'],
    probe: probe as unknown as ReactiveEvent['probe'],
  };
}

function canonicalEvent(
  probe: ProbeModule<TestBlock>,
  blockName: string,
): ReactiveEvent {
  return makeEvent(probe, h(blockName), [{ hash: h(blockName), canonical: true }]);
}

// -- Tests -------------------------------------------------------

Deno.test('new canonical block triggers verify action via probe', () => {
  const probe = setupProbe(block('A', 1000));
  const strategy = new SamplingStrategy();

  const actions = strategy.evaluate(canonicalEvent(probe, 'A'));

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'verify');
});

Deno.test('in-flight blocks are not re-verified', () => {
  const probe = setupProbe(block('A', 1000));
  const strategy = new SamplingStrategy();

  const first = strategy.evaluate(canonicalEvent(probe, 'A'));
  assertEquals(first.length, 1);

  const second = strategy.evaluate(canonicalEvent(probe, 'A'));
  assertEquals(second.length, 0);
});

Deno.test('maxConcurrent limit is respected', () => {
  const probe = setupProbe(block('A', 1000), block('B', 900), block('C', 800), block('D', 700));
  const strategy = new SamplingStrategy({ maxConcurrent: 2 });

  const event = makeEvent(probe, h('A'), [
    { hash: h('A'), canonical: true },
    { hash: h('B'), canonical: true },
    { hash: h('C'), canonical: true },
    { hash: h('D'), canonical: true },
  ]);

  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 2);
  assertEquals(strategy.inFlightCount, 2);
});

Deno.test('minPriority threshold filters low-priority blocks', () => {
  const probe = setupProbe(block('low', 1));
  const strategy = new SamplingStrategy({ minPriority: 1000 });

  const actions = strategy.evaluate(canonicalEvent(probe, 'low'));
  assertEquals(actions.length, 0);
});

Deno.test('completeVerification removes from inFlight', () => {
  const probe = setupProbe(block('A', 1000));
  const strategy = new SamplingStrategy({ maxConcurrent: 1 });

  strategy.evaluate(canonicalEvent(probe, 'A'));
  assertEquals(strategy.inFlightCount, 1);

  strategy.completeVerification(h('A'));
  assertEquals(strategy.inFlightCount, 0);
});

Deno.test('no action when no blocks need verification', () => {
  const probe = new ProbeModule<TestBlock>(new TestProvider());
  const strategy = new SamplingStrategy();

  const event = makeEvent(probe, h('X'), [{ hash: h('X'), canonical: true }]);
  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('no action when event has no canonical changes', () => {
  const probe = setupProbe(block('A', 1000));
  const strategy = new SamplingStrategy();

  const event = makeEvent(probe, h('A'), [{ hash: h('A'), canonical: false }]);
  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('completing a verification allows that slot to be reused', () => {
  const probe = setupProbe(block('A', 1000), block('B', 900));
  const strategy = new SamplingStrategy({ maxConcurrent: 1 });

  const first = strategy.evaluate(canonicalEvent(probe, 'A'));
  assertEquals(first.length, 1);

  // Complete A -- slot is free
  strategy.completeVerification(h('A'));

  // Now B can be verified
  const second = strategy.evaluate(canonicalEvent(probe, 'B'));
  assertEquals(second.length, 1);
});
