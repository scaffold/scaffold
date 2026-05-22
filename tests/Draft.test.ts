import { assert, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { createDraft, Draft, DraftStore } from '../src/core/Draft.ts';

function makeDraft(overrides?: Partial<Parameters<typeof createDraft>[0]>): Draft {
  return createDraft({
    claims: [{ producer: Hash.digest('b'), outputIndex: 0 }],
    outputs: [],
    declaredWeight: 10,
    ...overrides,
  });
}

// -- createDraft factory ------------------------------------------

Deno.test('createDraft: sets all fields, random draftId, status populating', () => {
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
  assertEquals(draft.status.phase, 'populating');
  assertEquals(draft.solidifiedBlocks, []);

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

Deno.test('getAll and getByPhase return correct subsets', () => {
  const store = new DraftStore();
  const d1 = makeDraft();
  const d2 = makeDraft();
  store.add(d1);
  store.add(d2);

  assertEquals(store.getAll().length, 2);
  assertEquals(store.getByPhase('populating').length, 2);
  assertEquals(store.getByPhase('ready').length, 0);

  store.transition(d1.draftId, { phase: 'ready' });
  assertEquals(store.getByPhase('populating').length, 1);
  assertEquals(store.getByPhase('ready').length, 1);
});

// -- State machine transitions ------------------------------------

Deno.test('valid transitions: populating -> ready', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  const updated = store.transition(draft.draftId, { phase: 'ready' });
  assertEquals(updated.status.phase, 'ready');
});

Deno.test('valid transitions: populating -> solidifying', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  const solidifying = store.transition(draft.draftId, { phase: 'solidifying' });
  assertEquals(solidifying.status.phase, 'solidifying');
});

Deno.test('valid transitions: each non-terminal -> cancelled', () => {
  for (const startStatus of ['populating', 'ready', 'solidifying'] as const) {
    const store = new DraftStore();
    const draft = makeDraft();
    store.add(draft);

    // Advance to startStatus
    if (startStatus === 'ready' || startStatus === 'solidifying') {
      store.transition(draft.draftId, { phase: 'ready' });
    }
    if (startStatus === 'solidifying') {
      store.transition(draft.draftId, { phase: 'solidifying' });
    }

    const cancelled = store.transition(draft.draftId, { phase: 'cancelled', reason: 'cancelled' });
    assertEquals(cancelled.status.phase, 'cancelled');
  }
});

Deno.test('invalid transitions throw: ready -> populating', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'ready' });
  assertThrows(
    () => store.transition(draft.draftId, { phase: 'populating' }),
    Error,
    'Invalid transition',
  );
});

Deno.test('invalid transitions throw: solidifying -> ready', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'solidifying' });
  assertThrows(
    () => store.transition(draft.draftId, { phase: 'ready' }),
    Error,
    'Invalid transition',
  );
});

Deno.test('invalid transitions throw: cancelled -> anything', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'cancelled', reason: 'cancelled' });
  // Terminal status means no further transitions are allowed.
  assertThrows(() => store.transition(draft.draftId, { phase: 'populating' }), Error);
});

Deno.test('terminal-phase drafts persist (no auto-removal on transition)', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, { phase: 'cancelled', reason: 'cancelled' });
  // Drafts persist in terminal status as historical record; only
  // explicit `remove(draftId)` drops them.
  const cancelled = store.get(draft.draftId);
  assert(cancelled !== undefined);
  assertEquals(cancelled!.status.phase, 'cancelled');
  assertEquals(store.size, 1);
});

Deno.test('transition returns new object, old reference unchanged (immutability)', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);

  const updated = store.transition(draft.draftId, { phase: 'ready' });
  assertEquals(draft.status.phase, 'populating'); // original unchanged
  assertEquals(updated.status.phase, 'ready');
  assert(Hash.equals(draft.draftId, updated.draftId));
  assert(draft !== updated);
});
