import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { Block, BlockStore } from '../src/core/Block.ts';
import { SamplingModule, SamplingProvider } from '../src/core/SamplingModule.ts';
import { Action, ReactiveEvent } from '../src/node/ReactiveLayer.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { SamplingStrategy } from '../src/node/strategies/SamplingStrategy.ts';

// -- Test helpers ------------------------------------------------

interface TestTree {
  hash: Hash;
  declaredWork: number;
  descendantWeight: number;
}

class TestProvider implements SamplingProvider<TestTree> {
  private trees = new Map<HashPrimitive, TestTree>();

  add(tree: TestTree): void {
    this.trees.set(tree.hash.toPrimitive(), tree);
  }

  getBlock(hash: Hash): TestTree | undefined {
    return this.trees.get(hash.toPrimitive());
  }

  getDeclaredWork(block: TestTree): number {
    return block.declaredWork;
  }

  getDescendantWeight(block: TestTree): number {
    return block.descendantWeight;
  }
}

const h = (name: string): Hash => Hash.digest(name);

function tree(name: string, declaredWork: number, descendantWeight = 0): TestTree {
  return { hash: h(name), declaredWork, descendantWeight };
}

/** Create a SamplingModule with registered trees. */
function setupSampling(...trees: TestTree[]): {
  provider: TestProvider;
  module: SamplingModule<TestTree>;
} {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  for (const t of trees) {
    provider.add(t);
    module.addTree(t.hash);
  }
  return { provider, module };
}

/** Create a minimal mock Block for the ReactiveEvent. */
function stubBlock(blockHash: Hash): Block {
  return { hash: blockHash } as unknown as Block;
}

/** Create a ReactiveEvent with canonicality changes. */
function makeEvent(
  module: SamplingModule<TestTree>,
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
    sampling: module as unknown as ReactiveEvent['sampling'],
  };
}

/** Shorthand: event with a single newly-canonical block. */
function canonicalEvent(
  module: SamplingModule<TestTree>,
  blockName: string,
): ReactiveEvent {
  return makeEvent(module, h(blockName), [{ hash: h(blockName), canonical: true }]);
}

// -- Tests -------------------------------------------------------

Deno.test('new canonical block triggers verify action when sampling says it needs verification', () => {
  const { module } = setupSampling(tree('A', 1000));
  const strategy = new SamplingStrategy();

  const actions = strategy.evaluate(canonicalEvent(module, 'A'));

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'verify');
  if (actions[0].type === 'verify') {
    assertEquals(Hash.equals(actions[0].block, h('A')), true);
  }
});

Deno.test('in-flight blocks are not re-verified', () => {
  const { module } = setupSampling(tree('A', 1000));
  const strategy = new SamplingStrategy();

  // First evaluation puts A in-flight.
  const first = strategy.evaluate(canonicalEvent(module, 'A'));
  assertEquals(first.length, 1);

  // Second evaluation should not re-verify A.
  const second = strategy.evaluate(canonicalEvent(module, 'A'));
  assertEquals(second.length, 0);
});

Deno.test('maxConcurrent limit is respected', () => {
  const trees = [tree('A', 1000), tree('B', 900), tree('C', 800), tree('D', 700)];
  const { module } = setupSampling(...trees);
  const strategy = new SamplingStrategy({ maxConcurrent: 2 });

  // Create an event with all four blocks becoming canonical.
  const event = makeEvent(module, h('A'), [
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
  // A tree with very low declared work will have low priority.
  const { module } = setupSampling(tree('low', 1));
  const strategy = new SamplingStrategy({ minPriority: 1000 });

  const actions = strategy.evaluate(canonicalEvent(module, 'low'));
  assertEquals(actions.length, 0);
});

Deno.test('completeVerification removes from inFlight', () => {
  const { module } = setupSampling(tree('A', 1000));
  const strategy = new SamplingStrategy({ maxConcurrent: 1 });

  // Verify A.
  strategy.evaluate(canonicalEvent(module, 'A'));
  assertEquals(strategy.inFlightCount, 1);

  // Complete verification.
  strategy.completeVerification(h('A'));
  assertEquals(strategy.inFlightCount, 0);
});

Deno.test('no action when no blocks need verification', () => {
  const provider = new TestProvider();
  const module = new SamplingModule(provider);
  // No trees registered at all.
  const strategy = new SamplingStrategy();

  const event = makeEvent(module, h('X'), [{ hash: h('X'), canonical: true }]);
  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('no action when event has no canonical changes', () => {
  const { module } = setupSampling(tree('A', 1000));
  const strategy = new SamplingStrategy();

  // Event with only off-canonical changes.
  const event = makeEvent(module, h('A'), [{ hash: h('A'), canonical: false }]);
  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('completing a verification allows that slot to be reused', () => {
  const { module } = setupSampling(tree('A', 1000), tree('B', 900));
  const strategy = new SamplingStrategy({ maxConcurrent: 1 });

  // Fill the single slot with A.
  const first = strategy.evaluate(canonicalEvent(module, 'A'));
  assertEquals(first.length, 1);
  if (first[0].type === 'verify') {
    assertEquals(Hash.equals(first[0].block, h('A')), true);
  }

  // Try to verify B — slot is full.
  const blocked = strategy.evaluate(canonicalEvent(module, 'B'));
  assertEquals(blocked.length, 0);

  // Complete A.
  strategy.completeVerification(h('A'));

  // Now B should be verifiable.
  const after = strategy.evaluate(canonicalEvent(module, 'B'));
  assertEquals(after.length, 1);
  if (after[0].type === 'verify') {
    assertEquals(Hash.equals(after[0].block, h('B')), true);
  }
});

Deno.test('verify action contains block hash and contract hash', () => {
  const { module } = setupSampling(tree('A', 1000));
  const strategy = new SamplingStrategy();

  const actions = strategy.evaluate(canonicalEvent(module, 'A'));
  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'verify');
  if (actions[0].type === 'verify') {
    // block should be the selected block.
    assertEquals(Hash.equals(actions[0].block, h('A')), true);
    // contract is the tree root hash.
    assertEquals(Hash.equals(actions[0].contract, h('A')), true);
    // params should be a Uint8Array.
    assertEquals(actions[0].params instanceof Uint8Array, true);
  }
});
