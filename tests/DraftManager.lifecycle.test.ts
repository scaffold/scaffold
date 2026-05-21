// Tests for the producer-agnostic DraftManager API: create, updateDraft,
// markReady, markSolidifying, cancel. Covers Chunk-2 test matrix categories
// A (lifecycle) and B (update locking) from the consolidation refactor plan.
//
// Re-solidify, multi-draft, and full-pipeline solidify tests live in:
//   tests/DraftManager.resolidify.test.ts (chunks 3-4)
//   tests/DraftManager.producer.test.ts   (chunk 2: producer-agnostic E1/E4)
//
// See plan: /Users/joel/.claude/plans/don-t-worry-about-gc-iterative-metcalfe.md

import { assert, assertEquals, assertFalse, assertThrows } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { Draft, DraftStore } from '../src/core/Draft.ts';
import { DraftManager } from '../src/core/DraftManager.ts';
import { StubGenerator } from '../src/core/Generator.ts';
import { ConsensusModule, ConsensusProvider } from '../src/core/ConsensusModule.ts';

// -- Test harness ------------------------------------------------

type TestEntity =
  | { kind: 'block'; hash: Hash; anchor: Hash; weight: number[] }
  | Draft;

function isDraft(e: TestEntity): e is Draft {
  return 'draftId' in e;
}

class TestProvider implements ConsensusProvider<TestEntity> {
  private blocks = new Map<HashPrimitive, TestEntity>();
  private draftStore?: DraftStore;

  add(entity: TestEntity): void {
    const key = isDraft(entity) ? entity.draftId.toPrimitive() : entity.hash.toPrimitive();
    this.blocks.set(key, entity);
  }
  setDraftStore(ds: DraftStore): void {
    this.draftStore = ds;
  }
  getBlock(h: Hash): TestEntity | undefined {
    return this.blocks.get(h.toPrimitive()) ?? this.draftStore?.get(h);
  }
  getHash(e: TestEntity): Hash {
    return isDraft(e) ? e.draftId : e.hash;
  }
  getAnchor(e: TestEntity): Hash {
    return isDraft(e) ? ZERO_HASH : e.anchor;
  }
  getAggregates(_: TestEntity): Hash[] {
    return [];
  }
  getWeightVector(e: TestEntity): number[] {
    return isDraft(e) ? [e.declaredWeight] : e.weight;
  }
}

function setup() {
  const provider = new TestProvider();
  const consensus = new ConsensusModule(provider);
  const store = new DraftStore();
  const generator = new StubGenerator();
  provider.setDraftStore(store);
  const manager = new DraftManager(store, consensus, generator);
  return { provider, consensus, store, generator, manager };
}

// =================================================================
// A. Lifecycle
// =================================================================

Deno.test('A: create returns a draft in `populating`', () => {
  const { manager, store, consensus } = setup();

  const draft = manager.create({ declaredWeight: 5 });

  assertEquals(draft.status.phase, 'populating');
  assertEquals(draft.declaredWeight, 5);
  assertEquals(draft.solidifiedBlocks, []);
  assertEquals(store.get(draft.draftId)?.status.phase, 'populating');
  // Registered as a phantom in consensus
  assert(consensus.isCanonical(draft.draftId));
});

Deno.test('A: create defaults', () => {
  const { manager } = setup();
  const draft = manager.create();
  assertEquals(draft.claims, []);
  assertEquals(draft.outputs, []);
  assertEquals(draft.refs, []);
  assertEquals(draft.declaredWeight, 0);
  assertEquals(draft.status.phase, 'populating');
});

Deno.test('A: markReady transitions populating -> ready', () => {
  const { manager, store } = setup();
  const draft = manager.create();

  const ready = manager.markReady(draft.draftId);
  assertEquals(ready.status.phase, 'ready');
  assertEquals(store.get(draft.draftId)?.status.phase, 'ready');
});

Deno.test('A: markReady is idempotent', () => {
  const { manager } = setup();
  const draft = manager.create();
  manager.markReady(draft.draftId);
  const again = manager.markReady(draft.draftId);
  assertEquals(again.status.phase, 'ready');
});

Deno.test('A: markReady throws from solidifying/solidified/cancelled', () => {
  const { manager, store } = setup();
  const draft = manager.create();

  // Force into solidifying directly via the store
  store.transition(draft.draftId, { phase: 'solidifying' });
  assertThrows(() => manager.markReady(draft.draftId), Error);

  // cancelled
  const d2 = manager.create();
  manager.cancel(d2.draftId);
  assertThrows(() => manager.markReady(d2.draftId), Error);
});

Deno.test('A: cancel during populating', () => {
  const { manager, store, consensus } = setup();
  const draft = manager.create();

  manager.cancel(draft.draftId, 'just because');

  const stored = store.get(draft.draftId);
  assert(stored !== undefined);
  assertEquals(stored!.status.phase, 'cancelled');
  if (stored!.status.phase === 'cancelled') {
    assertEquals(stored!.status.reason, 'just because');
  }
  // Phantom removed from consensus
  assertFalse(consensus.isCanonical(draft.draftId));
});

Deno.test('A: cancel during ready', () => {
  const { manager, store, consensus } = setup();
  const draft = manager.create();
  manager.markReady(draft.draftId);

  manager.cancel(draft.draftId);
  assertEquals(store.get(draft.draftId)?.status.phase, 'cancelled');
  assertFalse(consensus.isCanonical(draft.draftId));
});

Deno.test('A: cancel is idempotent (no-op when already cancelled)', () => {
  const { manager, store } = setup();
  const draft = manager.create();
  manager.cancel(draft.draftId, 'first');
  manager.cancel(draft.draftId, 'second');
  const stored = store.get(draft.draftId)!;
  assertEquals(stored.status.phase, 'cancelled');
  if (stored.status.phase === 'cancelled') {
    // First reason wins (we don't overwrite a terminal status)
    assertEquals(stored.status.reason, 'first');
  }
});

// =================================================================
// B. Update locking & weight monotonicity
// =================================================================

Deno.test('B: updateDraft appends claims/outputs/refs by default', () => {
  const { manager, store } = setup();
  const draft = manager.create({
    claims: [{ producer: Hash.digest('p'), outputIndex: 0 }],
  });

  manager.updateDraft(draft.draftId, {
    claims: [{ producer: Hash.digest('q'), outputIndex: 1 }],
    refs: [Hash.digest('r')],
  });

  const updated = store.get(draft.draftId)!;
  assertEquals(updated.claims.length, 2);
  assertEquals(updated.refs.length, 1);
});

Deno.test('B: updateDraft mode=replace overwrites', () => {
  const { manager, store } = setup();
  const draft = manager.create({
    claims: [{ producer: Hash.digest('p'), outputIndex: 0 }],
  });

  manager.updateDraft(
    draft.draftId,
    { claims: [{ producer: Hash.digest('q'), outputIndex: 1 }] },
    'replace',
  );

  const updated = store.get(draft.draftId)!;
  assertEquals(updated.claims.length, 1);
  assertEquals(updated.claims[0].outputIndex, 1);
});

Deno.test('B: updateDraft after markReady throws', () => {
  const { manager } = setup();
  const draft = manager.create();
  manager.markReady(draft.draftId);

  assertThrows(
    () => manager.updateDraft(draft.draftId, { refs: [Hash.digest('r')] }),
    Error,
    'locked',
  );
});

Deno.test('B: updateDraft after cancel throws', () => {
  const { manager } = setup();
  const draft = manager.create();
  manager.cancel(draft.draftId);

  assertThrows(
    () => manager.updateDraft(draft.draftId, { refs: [Hash.digest('r')] }),
    Error,
    'locked',
  );
});

Deno.test('B: updateDraft raises declaredWeight, re-registers consensus weight', () => {
  const { manager, store, consensus } = setup();
  const draft = manager.create({ declaredWeight: 5 });

  manager.updateDraft(draft.draftId, { declaredWeight: 12 });
  const updated = store.get(draft.draftId)!;
  assertEquals(updated.declaredWeight, 12);
  // Consensus reflects the new declared weight.
  assertEquals(
    consensus.getEffectiveWeight(draft.draftId),
    12,
  );
});

Deno.test('B: updateDraft rejects declaredWeight decrease (monotone non-decreasing)', () => {
  const { manager } = setup();
  const draft = manager.create({ declaredWeight: 10 });

  assertThrows(
    () => manager.updateDraft(draft.draftId, { declaredWeight: 5 }),
    Error,
    'monotone',
  );
});

Deno.test('B: updateDraft allows equal declaredWeight (idempotent set)', () => {
  const { manager } = setup();
  const draft = manager.create({ declaredWeight: 10 });
  manager.updateDraft(draft.draftId, { declaredWeight: 10 });
  // No throw; draft is unchanged.
});

Deno.test('B: updateDraft on missing draftId throws', () => {
  const { manager } = setup();
  assertThrows(
    () => manager.updateDraft(Hash.random(), { refs: [Hash.digest('r')] }),
    Error,
    'not in store',
  );
});
