import { assert, assertEquals, assertNotEquals, assertThrows } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Draft, ClaimIntent, createDraft, DraftStore } from '../src/core/Draft.ts';

const anchor = Hash.digest('anchor');

function makeDraft(overrides?: Partial<Parameters<typeof createDraft>[0]>): Draft {
  return createDraft({
    claims: [{ producer: Hash.digest('b'), outputIndex: 0 }],
    outputs: [],
    declaredWeight: 10,
    anchor,
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
    anchor,
  });

  assertEquals(draft.claims, [claim]);
  assertEquals(draft.outputs, []);
  assertEquals(draft.declaredWeight, 5);
  assert(Hash.equals(draft.anchor, anchor));
  assertEquals(draft.refs, []);
  assertEquals(draft.status, 'pending');

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
    anchor,
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
  assertEquals(store.getByStatus('pending').length, 2);
  assertEquals(store.getByStatus('generating').length, 0);

  store.transition(d1.draftId, 'generating');
  assertEquals(store.getByStatus('pending').length, 1);
  assertEquals(store.getByStatus('generating').length, 1);
});

// -- State machine transitions ------------------------------------

Deno.test('valid transitions: pending -> generating', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  const updated = store.transition(draft.draftId, 'generating');
  assertEquals(updated.status, 'generating');
});

Deno.test('valid transitions: generating -> ready', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, 'generating');
  const ready = store.transition(draft.draftId, 'ready');
  assertEquals(ready.status, 'ready');
});

Deno.test('valid transitions: each -> cancelled', () => {
  for (const startStatus of ['pending', 'generating', 'ready'] as const) {
    const store = new DraftStore();
    const draft = makeDraft();
    store.add(draft);

    // Advance to startStatus
    if (startStatus === 'generating' || startStatus === 'ready') {
      store.transition(draft.draftId, 'generating');
    }
    if (startStatus === 'ready') {
      store.transition(draft.draftId, 'ready');
    }

    const cancelled = store.transition(draft.draftId, 'cancelled');
    assertEquals(cancelled.status, 'cancelled');
  }
});

Deno.test('invalid transitions throw: generating -> pending', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, 'generating');
  assertThrows(
    () => store.transition(draft.draftId, 'pending'),
    Error,
    'Invalid transition',
  );
});

Deno.test('invalid transitions throw: ready -> generating', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, 'generating');
  store.transition(draft.draftId, 'ready');
  assertThrows(
    () => store.transition(draft.draftId, 'generating'),
    Error,
    'Invalid transition',
  );
});

Deno.test('invalid transitions throw: cancelled -> anything', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, 'cancelled');
  // Draft is removed, so transition will fail with "not found"
  assertThrows(() => store.transition(draft.draftId, 'pending'), Error);
});

Deno.test('transition to cancelled removes from store', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, 'cancelled');
  assertEquals(store.get(draft.draftId), undefined);
  assertEquals(store.size, 0);
});

Deno.test('transition returns new object, old reference unchanged (immutability)', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);

  const updated = store.transition(draft.draftId, 'generating');
  assertEquals(draft.status, 'pending'); // original unchanged
  assertEquals(updated.status, 'generating');
  assert(Hash.equals(draft.draftId, updated.draftId));
  assert(draft !== updated);
});

// -- recreate -----------------------------------------------------

Deno.test('recreate: new draftId, old removed, changes applied, unspecified fields preserved', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);

  const newAnchor = Hash.digest('new-anchor');
  const recreated = store.recreate(draft.draftId, { anchor: newAnchor });

  // Old removed
  assertEquals(store.get(draft.draftId), undefined);

  // New exists with new id
  assertNotEquals(recreated.draftId.toPrimitive(), draft.draftId.toPrimitive());
  assertEquals(store.get(recreated.draftId), recreated);

  // Changes applied
  assert(Hash.equals(recreated.anchor, newAnchor));

  // Unspecified fields preserved
  assertEquals(recreated.declaredWeight, draft.declaredWeight);
  assertEquals(recreated.claims, draft.claims);
});

Deno.test('recreate defaults status to pending', () => {
  const store = new DraftStore();
  const draft = makeDraft();
  store.add(draft);
  store.transition(draft.draftId, 'generating');

  const recreated = store.recreate(draft.draftId, {});
  assertEquals(recreated.status, 'pending');
});
