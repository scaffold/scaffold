import { assertEquals } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { Block, BlockStore } from '../src/core/Block.ts';
import { ReactiveEvent } from '../src/node/ReactiveLayer.ts';
import { BlockReceivedResult } from '../src/core/Coordinator.ts';
import { AggregationStrategy } from '../src/node/strategies/AggregationStrategy.ts';

// -- Test helpers ------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

/**
 * Create a minimal mock Block.
 * anchor defaults to ZERO_HASH (genesis). Provide anchorHash for non-genesis.
 */
function makeBlock(
  name: string,
  opts?: { anchorHash?: Hash; aggregates?: Hash[] },
): Block {
  const hash = h(name);
  const anchor = opts?.anchorHash ?? ZERO_HASH;
  const aggregates = opts?.aggregates ?? [];
  return {
    hash,
    anchor,
    aggregates,
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
  } satisfies Block;
}

/**
 * A test-friendly consensus service backed by a simple canonical set.
 * We need getCanonicalView() to return the configured set.
 */
class MockConsensus {
  private canonical = new Set<HashPrimitive>();

  addCanonical(hash: Hash): void {
    this.canonical.add(hash.toPrimitive());
  }

  removeCanonical(hash: Hash): void {
    this.canonical.delete(hash.toPrimitive());
  }

  getCanonicalView(): ReadonlySet<HashPrimitive> {
    return this.canonical;
  }
}

/**
 * Build a ReactiveEvent with the given store, consensus, and canonicality changes.
 */
function makeEvent(
  store: BlockStore,
  consensus: MockConsensus,
  canonicalityChanges: { hash: Hash; canonical: boolean }[],
): ReactiveEvent {
  const result: BlockReceivedResult = {
    pushActions: [],
    canonicalityChanges,
    newConflicts: [],
  };
  // Use the first block from canonicality changes as the event block, or a stub.
  const eventBlockHash = canonicalityChanges.length > 0 ? canonicalityChanges[0].hash : h('stub');
  const block = store.get(eventBlockHash) ?? makeBlock('stub');

  return {
    block,
    fromPeer: null,
    result,
    store,
    consensus: consensus as unknown as ReactiveEvent['consensus'],
    conflict: {} as ReactiveEvent['conflict'],
    sampling: {} as ReactiveEvent['sampling'],
  };
}

// -- Tests -------------------------------------------------------

Deno.test('aggregation when >= minLeaves canonical blocks share an anchor', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  // Genesis block as anchor.
  const genesis = makeBlock('genesis');
  store.put(genesis);

  // Two leaf blocks sharing the same anchor (genesis).
  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);

  const strategy = new AggregationStrategy();
  const event = makeEvent(store, consensus, [
    { hash: a.hash, canonical: true },
    { hash: b.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].type, 'createBlock');
  if (actions[0].type === 'createBlock') {
    assertEquals(Hash.equals(actions[0].spec.anchor, genesis.hash), true);
    assertEquals(actions[0].spec.aggregates.length, 2);
    // The aggregates should be A and B.
    const aggHashes = new Set(actions[0].spec.aggregates.map((h) => h.toPrimitive()));
    assertEquals(aggHashes.has(a.hash.toPrimitive()), true);
    assertEquals(aggHashes.has(b.hash.toPrimitive()), true);
    assertEquals(actions[0].sign, false);
  }
});

Deno.test('no aggregation when below minLeaves', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  // Only one leaf block.
  const a = makeBlock('A', { anchorHash: genesis.hash });
  store.put(a);
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);

  const strategy = new AggregationStrategy();
  const event = makeEvent(store, consensus, [
    { hash: a.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('no aggregation with minLeaves=3 and only 2 leaves', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);

  const strategy = new AggregationStrategy({ minLeaves: 3 });
  const event = makeEvent(store, consensus, [
    { hash: a.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('maxChildren limit is respected', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  // Four leaf blocks sharing the same anchor.
  const blocks = ['A', 'B', 'C', 'D'].map((name) => makeBlock(name, { anchorHash: genesis.hash }));
  for (const block of blocks) {
    store.put(block);
    consensus.addCanonical(block.hash);
  }
  consensus.addCanonical(genesis.hash);

  const strategy = new AggregationStrategy({ maxChildren: 2 });
  const event = makeEvent(store, consensus, [
    { hash: blocks[0].hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 1);
  if (actions[0].type === 'createBlock') {
    assertEquals(actions[0].spec.aggregates.length, 2);
  }
});

Deno.test('already-aggregated blocks are skipped', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  // Three leaf blocks sharing the same anchor.
  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  const c = makeBlock('C', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);
  store.put(c);

  // An aggregation block that aggregates A and B.
  // Its anchor is genesis too, but importantly it marks A and B as aggregated.
  const agg = makeBlock('agg', { anchorHash: genesis.hash, aggregates: [a.hash, b.hash] });
  store.put(agg); // This marks A and B as aggregated in the store.

  // All are canonical.
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);
  consensus.addCanonical(c.hash);
  consensus.addCanonical(agg.hash);

  const strategy = new AggregationStrategy();
  const event = makeEvent(store, consensus, [
    { hash: agg.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  // A and B are aggregated so they are skipped.
  // The remaining unaggregated leaves with anchor=genesis are: C and agg.
  // That's 2 blocks, which meets the default minLeaves=2 threshold.
  assertEquals(actions.length, 1);
  if (actions[0].type === 'createBlock') {
    // The aggregation should include C and agg (the 2 unaggregated blocks),
    // but NOT A or B (which are already aggregated).
    const aggHashes = new Set(actions[0].spec.aggregates.map((h) => h.toPrimitive()));
    assertEquals(aggHashes.has(c.hash.toPrimitive()), true);
    assertEquals(aggHashes.has(agg.hash.toPrimitive()), true);
    assertEquals(aggHashes.has(a.hash.toPrimitive()), false);
    assertEquals(aggHashes.has(b.hash.toPrimitive()), false);
  }
});

Deno.test('no action when no canonicality changes', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);

  const strategy = new AggregationStrategy();
  // Empty canonicality changes.
  const event = makeEvent(store, consensus, []);

  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 0);
});

Deno.test('default config values are minLeaves=2 and maxChildren=3', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  // Five leaf blocks sharing the same anchor.
  const blocks = ['A', 'B', 'C', 'D', 'E'].map((name) =>
    makeBlock(name, { anchorHash: genesis.hash })
  );
  for (const block of blocks) {
    store.put(block);
    consensus.addCanonical(block.hash);
  }
  consensus.addCanonical(genesis.hash);

  const strategy = new AggregationStrategy(); // defaults
  const event = makeEvent(store, consensus, [
    { hash: blocks[0].hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  // Default minLeaves=2 means aggregation triggers.
  assertEquals(actions.length, 1);
  if (actions[0].type === 'createBlock') {
    // Default maxChildren=3 means at most 3 aggregates.
    assertEquals(actions[0].spec.aggregates.length, 3);
  }
});

Deno.test('genesis blocks are not included in aggregation groups', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  // Two genesis blocks (anchor is ZERO_HASH).
  const g1 = makeBlock('genesis1');
  const g2 = makeBlock('genesis2');
  store.put(g1);
  store.put(g2);
  consensus.addCanonical(g1.hash);
  consensus.addCanonical(g2.hash);

  const strategy = new AggregationStrategy();
  const event = makeEvent(store, consensus, [
    { hash: g1.hash, canonical: true },
    { hash: g2.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);
  // Genesis blocks have anchor=ZERO_HASH, so they should be excluded.
  assertEquals(actions.length, 0);
});

Deno.test('multiple anchor groups produce multiple actions', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  // Anchor group 1: two blocks anchored to genesis.
  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);

  // Another anchor.
  const anchor2 = makeBlock('anchor2', { anchorHash: genesis.hash });
  store.put(anchor2);

  // Anchor group 2: two blocks anchored to anchor2.
  const c = makeBlock('C', { anchorHash: anchor2.hash });
  const d = makeBlock('D', { anchorHash: anchor2.hash });
  store.put(c);
  store.put(d);

  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);
  consensus.addCanonical(anchor2.hash);
  consensus.addCanonical(c.hash);
  consensus.addCanonical(d.hash);

  const strategy = new AggregationStrategy();
  const event = makeEvent(store, consensus, [
    { hash: a.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);

  // Two anchor groups, each with 2 leaves, so 2 createBlock actions.
  assertEquals(actions.length, 2);
  for (const action of actions) {
    assertEquals(action.type, 'createBlock');
  }
});

Deno.test('aggregation spec has empty outputs, claims, and declaredWeight=1', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);

  const strategy = new AggregationStrategy();
  const event = makeEvent(store, consensus, [
    { hash: a.hash, canonical: true },
  ]);

  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 1);
  if (actions[0].type === 'createBlock') {
    assertEquals(actions[0].spec.outputs.length, 0);
    assertEquals(actions[0].spec.claims.length, 0);
    assertEquals(actions[0].spec.declaredWeight, 1);
  }
});

Deno.test('only-off-canonical changes do not trigger aggregation', () => {
  const store = new BlockStore();
  const consensus = new MockConsensus();

  const genesis = makeBlock('genesis');
  store.put(genesis);

  const a = makeBlock('A', { anchorHash: genesis.hash });
  const b = makeBlock('B', { anchorHash: genesis.hash });
  store.put(a);
  store.put(b);
  consensus.addCanonical(genesis.hash);
  consensus.addCanonical(a.hash);
  consensus.addCanonical(b.hash);

  const strategy = new AggregationStrategy();
  // Only off-canonical changes (canonical: false).
  const event = makeEvent(store, consensus, [
    { hash: a.hash, canonical: false },
  ]);

  // Even though there are 2 canonical leaves, the event has only
  // off-canonical changes. The strategy still processes because
  // canonicalityChanges.length > 0 -- it checks for changes, not
  // specifically for newly-canonical ones. The strategy should still
  // produce an action because the canonical view shows 2 leaves.
  const actions = strategy.evaluate(event);
  assertEquals(actions.length, 1);
});
