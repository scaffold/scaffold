import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import { Block, BlockStore } from '../src/core/Block.ts';
import { ReactiveEvent } from '../src/node/ReactiveLayer.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { DisputeStrategy } from '../src/node/strategies/DisputeStrategy.ts';

// -- Test helpers ------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

/** Create a minimal mock Block for the ReactiveEvent. */
function stubBlock(blockHash: Hash): Block {
  return { hash: blockHash } as unknown as Block;
}

/** Create a mock ConsensusService with a configurable canonical view. */
function mockConsensus(canonicalHashes: Hash[]): ReactiveEvent['consensus'] {
  const canonical = new Set<HashPrimitive>(
    canonicalHashes.map((h) => h.toPrimitive()),
  );
  return {
    getCanonicalView: () => canonical,
  } as unknown as ReactiveEvent['consensus'];
}

/** Create a ReactiveEvent with the given canonical view and canonicality changes. */
function makeEvent(
  canonicalHashes: Hash[],
  blockHash: Hash,
  canonicalityChanges: { hash: Hash; canonical: boolean }[] = [],
): ReactiveEvent {
  const result: BlockReceivedResult = {
    canonicalityChanges,
    newConflicts: [],
  };
  return {
    block: stubBlock(blockHash),
    fromPeer: null,
    result,
    store: new BlockStore(),
    consensus: mockConsensus(canonicalHashes),
    sampling: {} as ReactiveEvent['sampling'],
  };
}

// -- Tests -------------------------------------------------------

Deno.test('invalid verification triggers dispute action', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');

  // Report block A as invalid.
  strategy.reportInvalid(blockA);

  // Block A is canonical, so evaluate should produce a dispute action.
  const event = makeEvent([blockA], blockA, [
    { hash: blockA, canonical: true },
  ]);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'dispute');
  if (actions[0].type === 'dispute') {
    assertEquals(Hash.equals(actions[0].block, blockA), true);
    assertEquals(actions[0].side, 'against');
  }
});

Deno.test('duplicate disputes are prevented', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');

  strategy.reportInvalid(blockA);

  const event = makeEvent([blockA], blockA, [
    { hash: blockA, canonical: true },
  ]);

  // First evaluation should create a dispute.
  const first = strategy.evaluate(event);
  assertEquals(first.length, 1);

  // Second evaluation should NOT create another dispute for the same block.
  const second = strategy.evaluate(event);
  assertEquals(second.length, 0);
});

Deno.test('disputes are not created when disabled', () => {
  const strategy = new DisputeStrategy({ enabled: false });
  const blockA = h('A');

  strategy.reportInvalid(blockA);

  const event = makeEvent([blockA], blockA, [
    { hash: blockA, canonical: true },
  ]);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('reportInvalid/isInvalid tracking', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');
  const blockB = h('B');

  // Initially nothing is invalid.
  assertEquals(strategy.isInvalid(blockA), false);
  assertEquals(strategy.isInvalid(blockB), false);

  // Report A as invalid.
  strategy.reportInvalid(blockA);
  assertEquals(strategy.isInvalid(blockA), true);
  assertEquals(strategy.isInvalid(blockB), false);

  // Report B as invalid.
  strategy.reportInvalid(blockB);
  assertEquals(strategy.isInvalid(blockA), true);
  assertEquals(strategy.isInvalid(blockB), true);
});

Deno.test('no action when no blocks are invalid', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');

  // Block A is canonical but not reported as invalid.
  const event = makeEvent([blockA], blockA, [
    { hash: blockA, canonical: true },
  ]);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 0);
});

Deno.test('only canonical invalid blocks get disputes', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');
  const blockB = h('B');

  // Report both A and B as invalid.
  strategy.reportInvalid(blockA);
  strategy.reportInvalid(blockB);

  // But only A is canonical.
  const event = makeEvent([blockA], blockA, [
    { hash: blockA, canonical: true },
  ]);
  const actions = strategy.evaluate(event);

  // Should only dispute A (which is canonical), not B.
  assertEquals(actions.length, 1);
  if (actions[0].type === 'dispute') {
    assertEquals(Hash.equals(actions[0].block, blockA), true);
  }

  // Now make B canonical too and evaluate again.
  const event2 = makeEvent([blockA, blockB], blockB, [
    { hash: blockB, canonical: true },
  ]);
  const actions2 = strategy.evaluate(event2);

  // A was already disputed; B is now canonical and should be disputed.
  assertEquals(actions2.length, 1);
  if (actions2[0].type === 'dispute') {
    assertEquals(Hash.equals(actions2[0].block, blockB), true);
  }
});

Deno.test('multiple invalid canonical blocks produce multiple disputes', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');
  const blockB = h('B');
  const blockC = h('C');

  strategy.reportInvalid(blockA);
  strategy.reportInvalid(blockB);
  strategy.reportInvalid(blockC);

  // All three are canonical.
  const event = makeEvent([blockA, blockB, blockC], blockA, [
    { hash: blockA, canonical: true },
    { hash: blockB, canonical: true },
    { hash: blockC, canonical: true },
  ]);
  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 3);
  for (const action of actions) {
    assertEquals(action.type, 'dispute');
    if (action.type === 'dispute') {
      assertEquals(action.side, 'against');
    }
  }
});

Deno.test('re-reporting an already-invalid block is idempotent', () => {
  const strategy = new DisputeStrategy();
  const blockA = h('A');

  strategy.reportInvalid(blockA);
  strategy.reportInvalid(blockA);

  assertEquals(strategy.isInvalid(blockA), true);

  const event = makeEvent([blockA], blockA);
  const actions = strategy.evaluate(event);

  // Should still only produce one dispute.
  assertEquals(actions.length, 1);
});
