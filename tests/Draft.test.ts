import { assert, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Draft, ClaimIntent, createDraft, DraftStore } from '../src/core/Draft.ts';

function makeDraft(overrides?: Partial<Parameters<typeof createDraft>[0]>): Draft {
  return createDraft({
    claims: [{ producer: Hash.digest('b'), outputIndex: 0 }],
    outputs: [],
    declaredWeight: 10,
    ...overrides,
  });
}

// -- createDraft factory ------------------------------------------

Deno.test('createDraft: sets all fields, random draftId, status pending', () => {
  const claim = { producer: Hash.digest('b'), outputIndex: 1 };
  const draft = createDraft({
    claims: [claim],
    outputs: [],
    declaredWeight: 5,
  });

  assertEquals(draft.claims, [claim]);
  assertEquals(draft.outputs, []);
  assertEquals(draft.declaredWeight, 5);
  assertEquals(draft.refs, []);
  assertEquals(draft.status.phase, 'pending');

  // draftId should be a valid Hash (random)
  assert(draft.draftId instanceof Hash);
});

Deno.test('createDraft: two calls produce different draftIds', () => {
  const a = makeDraft();
  const b = makeDraft();
  assertNotEquals(a.draftId.toPrimitive(), b.draftId.toPrimitive());
});

Deno.test('createDraft: optional refs', () => {
  const r = Hash.digest('ref');
  const draft = createDraft({
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [r],
  });
  assertEquals(draft.refs.length, 1);
  assert(Hash.equals(draft.refs[0], r));
});

// -- DraftStore CRUD ----------------------------------------------

Deno.test('add / get / remove basic CRUD', () => {
  const store = new DraftStore();
  const draft = makeDraft();

  store.add(draft);
  assertEquals(store.size, 1);
  assertEquals(store.get(draft.draftId), draft);

  store.remove(draft.draftId);
  assertEquals(store.size, 0);
  assertEquals(store.get(draft.draftId), undefined);
});

Deno.test('add duplicate draftId throws', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  assertThrows(() => store.add(draft), Error, 'already exists');
});

Deno.test('getAll and getByStatus return correct subsets', () => {
  const store = new DraftStore();
  const d1 = makeDraft();
  const d2 = makeDraft();
  store.add(d1);
  store.add(d2);

  assertEquals(store.getAll().length, 2);
  assertEquals(store.getByPhase('pending').length, 2);
  assertEquals(store.getByPhase('generating').length, 0);

  store.transition(d1.draftId, { phase: 'generating' });
  assertEquals(store.getByPhase('pending').length, 1);
  assertEquals(store.getByPhase('generating').length, 1);
});

// -- State machine transitions ------------------------------------

Deno.test('valid transitions: pending -> generating', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  const updated = store.transition(draft.draftId, { phase: 'generating' });
  assertEquals(updated.status.phase, 'generating');
});

Deno.test('valid transitions: generating -> ready', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'generating' });
  const ready = store.transition(draft.draftId, { phase: 'readyToSolidify' });
  assertEquals(ready.status.phase, 'readyToSolidify');
});

Deno.test('valid transitions: each -> cancelled', () => {
  for (const startStatus of ['pending', 'generating', 'ready'] as const) {
    const store = new DraftStore();
    const draft = makeDraft();
    store.add(draft);

    // Advance to startStatus
    if (startStatus === 'generating' || startStatus === 'ready') {
      store.transition(draft.draftId, { phase: 'generating' });
    }
    if (startStatus === 'ready') {
      store.transition(draft.draftId, { phase: 'readyToSolidify' });
    }

    const cancelled = store.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
    assertEquals(cancelled.status.phase, 'failed');
  }
});

Deno.test('invalid transitions throw: generating -> pending', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'generating' });
  assertThrows(
    () => store.transition(draft.draftId, { phase: 'pending' }),
    Error,
    'Invalid transition',
  );
});

Deno.test('invalid transitions throw: ready -> generating', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'generating' });
  store.transition(draft.draftId, { phase: 'readyToSolidify' });
  assertThrows(
    () => store.transition(draft.draftId, { phase: 'generating' }),
    Error,
    'Invalid transition',
  );
});

Deno.test('invalid transitions throw: cancelled -> anything', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
  // Terminal status means no further transitions are allowed.
  assertThrows(() => store.transition(draft.draftId, { phase: 'pending' }), Error);
});

Deno.test('terminal-phase drafts persist (no auto-removal on transition)', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'failed', reason: 'cancelled', at: 'cancelled' });
  // Drafts persist in terminal status as historical record; only
  // explicit `remove(draftId)` drops them.
  const failed = store.get(draft.draftId);
  assert(failed !== undefined);
  assertEquals(failed!.status.phase, 'failed');
  assertEquals(store.size, 1);
});

Deno.test('transition returns new object, old reference unchanged (immutability)', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);

  const updated = store.transition(draft.draftId, { phase: 'generating' });
  assertEquals(draft.status.phase, 'pending'); // original unchanged
  assertEquals(updated.status.phase, 'generating');
  assert(Hash.equals(draft.draftId, updated.draftId));
  assert(draft !== updated);
});

// -- recreate -----------------------------------------------------

Deno.test('recreate: new draftId, old removed, changes applied, unspecified fields preserved', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);

  const newRefs = [Hash.digest('new-ref')];
  const recreated = store.recreate(draft.draftId, { refs: newRefs });

  // Old removed
  assertEquals(store.get(draft.draftId), undefined);

  // New exists with new id
  assertNotEquals(recreated.draftId.toPrimitive(), draft.draftId.toPrimitive());
  assertEquals(store.get(recreated.draftId), recreated);

  // Changes applied
  assertEquals(recreated.refs.length, 1);
  assert(Hash.equals(recreated.refs[0], newRefs[0]));

  // Unspecified fields preserved
  assertEquals(recreated.declaredWeight, draft.declaredWeight);
  assertEquals(recreated.claims, draft.claims);
});

Deno.test('recreate defaults status to pending', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'generating' });

  const recreated = store.recreate(draft.draftId, {});
  assertEquals(recreated.status.phase, 'pending');
});
