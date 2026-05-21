// Tests for producer-agnostic DraftManager usage: drafts created and
// populated by external producers (PutManager-direct, FetchManager
// incentive, GenerationService) all use the same `create -> updateDraft ->
// markReady|markSolidifying` shape. Covers Chunk-2 test matrix category E.
//
// E2/E3 (incremental vs batch producers driving generation) exercise the
// generator pipeline more deeply and live in the integration suite.
//
// See plan: /Users/joel/.claude/plans/don-t-worry-about-gc-iterative-metcalfe.md

import { assert, assertEquals, assertFalse } from '@std/assert';
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

function setupWithoutGenerator() {
  const provider = new TestProvider();
  const consensus = new ConsensusModule(provider);
  const store = new DraftStore();
  // StubGenerator with no behavior -- producers don't call into it.
  const generator = new StubGenerator();
  provider.setDraftStore(store);
  const manager = new DraftManager(store, consensus, generator);
  return { provider, consensus, store, manager };
}

// =================================================================
// E1. Producer-agnostic: works without a generator running
// =================================================================

Deno.test('E1: FetchManager-style flow -- create + markReady, no generator', () => {
  const { manager, store, consensus } = setupWithoutGenerator();

  // FetchManager incentive: create draft with predetermined incentive output,
  // mark ready (or solidifying), expect no generator involvement.
  const draft = manager.create({
    outputs: [],
    declaredWeight: 0,
  });

  assertEquals(draft.status.phase, 'populating');
  manager.markReady(draft.draftId);
  assertEquals(store.get(draft.draftId)?.status.phase, 'ready');
  assert(consensus.isCanonical(draft.draftId));
});

Deno.test('E1: PutManager-style flow -- create + updateDraft + markReady', () => {
  const { manager, store } = setupWithoutGenerator();

  // PutManager park flow: create empty draft, populate via updateDraft,
  // mark ready (not solidifying -- it's parked).
  const draft = manager.create();
  manager.updateDraft(draft.draftId, {
    claims: [{ producer: Hash.digest('p'), outputIndex: 0 }],
    refs: [Hash.digest('r')],
    declaredWeight: 7,
  });
  manager.markReady(draft.draftId);

  const stored = store.get(draft.draftId)!;
  assertEquals(stored.status.phase, 'ready');
  assertEquals(stored.claims.length, 1);
  assertEquals(stored.refs.length, 1);
  assertEquals(stored.declaredWeight, 7);
});

Deno.test('E1: synchronous producer -- create + updateDraft + markReady in one tick', () => {
  const { manager, store } = setupWithoutGenerator();

  // Synchronous producer (Scaffold.send-style): everything in one call.
  const draft = manager.create();
  manager.updateDraft(draft.draftId, {
    outputs: [{
      verifier: { contract: Hash.digest('c'), params: new Uint8Array() },
      value: 1,
      body: new Uint8Array(),
    }],
  });
  manager.markReady(draft.draftId);

  const stored = store.get(draft.draftId)!;
  assertEquals(stored.status.phase, 'ready');
  assertEquals(stored.outputs.length, 1);
});

// =================================================================
// E4. Producer hard-error path
// =================================================================

Deno.test('E4: producer cancel during populating', () => {
  const { manager, store, consensus } = setupWithoutGenerator();

  // Producer encounters a hard error (e.g. failed sign, contract reject)
  // and calls cancel directly. Draft transitions to cancelled, phantom
  // is removed from consensus, content is retained for debug.
  const draft = manager.create({
    claims: [{ producer: Hash.digest('p'), outputIndex: 0 }],
  });
  manager.updateDraft(draft.draftId, {
    refs: [Hash.digest('r')],
  });

  manager.cancel(draft.draftId, 'sign-failed');

  const stored = store.get(draft.draftId)!;
  assertEquals(stored.status.phase, 'cancelled');
  if (stored.status.phase === 'cancelled') {
    assertEquals(stored.status.reason, 'sign-failed');
  }
  // Cancelled drafts retain their content for debugging.
  assertEquals(stored.claims.length, 1);
  assertEquals(stored.refs.length, 1);
  // Phantom removed from consensus.
  assertFalse(consensus.isCanonical(draft.draftId));
});

Deno.test('E4: cancel from populating retains content even when claims grew', () => {
  const { manager, store } = setupWithoutGenerator();

  const draft = manager.create();
  manager.updateDraft(draft.draftId, {
    claims: [{ producer: Hash.digest('a'), outputIndex: 0 }],
  });
  manager.updateDraft(draft.draftId, {
    claims: [{ producer: Hash.digest('b'), outputIndex: 0 }],
  });

  manager.cancel(draft.draftId, 'producer-aborted');

  const stored = store.get(draft.draftId)!;
  assertEquals(stored.claims.length, 2);
  assertEquals(stored.status.phase, 'cancelled');
});
