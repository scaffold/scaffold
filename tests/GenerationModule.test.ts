import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import type { Verifier } from '../src/core/BlockCreationModule.ts';
import {
  GenerationModule,
  type GenerationProvider,
  type GenerationSpec,
} from '../src/node/GenerationModule.ts';

// -- Helpers ------------------------------------------------------

function hashOf(tag: string): Hash {
  // Use a tiny, reversible mapping from the tag letters to hex so callers
  // can keep using short labels like 'a' / 'v' / 't1'.
  let hex = '';
  for (const c of tag) hex += c.charCodeAt(0).toString(16).padStart(2, '0');
  return Hash.fromHex(hex.padEnd(64, '0').slice(0, 64));
}

function verifier(tag: string, params: number[] = []): Verifier {
  return { contract: hashOf(tag), params: new Uint8Array(params) };
}

interface World {
  provider: GenerationProvider;
  module: GenerationModule;
  created: GenerationSpec[];
  restarts: { previousDraftId: Hash; targetKey: string }[];
  /** Map from spec to the next draftId returned by createDraft. */
  nextDraftId: () => Hash;
}

function makeWorld(opts: { uncanonicalFactor?: number } = {}): World {
  const created: GenerationSpec[] = [];
  const restarts: { previousDraftId: Hash; targetKey: string }[] = [];
  let counter = 0;

  const provider: GenerationProvider = {
    createDraft: (spec) => {
      created.push(spec);
      counter++;
      return hashOf(`d${counter.toString(16)}`);
    },
    triggerRestart: (previousDraftId, targetKey) => {
      restarts.push({ previousDraftId, targetKey });
    },
  };

  const module = new GenerationModule(provider, opts);

  return {
    provider,
    module,
    created,
    restarts,
    nextDraftId: () => hashOf(`d${(counter + 1).toString(16)}`),
  };
}

// -- Tests --------------------------------------------------------

Deno.test('GenerationModule: startGeneration creates draft and tracks it', () => {
  const w = makeWorld();
  const id = w.module.startGeneration({
    targetKey: 't1',
    anchor: hashOf('a'),
    verifier: verifier('v'),
    declaredWeight: 100,
  });
  assertEquals(w.created.length, 1);
  assertEquals(w.module.size, 1);
  assertEquals(w.module.priority(id), 100); // canonical by default
});

Deno.test('GenerationModule: priority drops to declaredWeight*factor when uncanonical', () => {
  const w = makeWorld({ uncanonicalFactor: 0.25 });
  const id = w.module.startGeneration({
    targetKey: 't1',
    anchor: hashOf('a'),
    verifier: verifier('v'),
    declaredWeight: 200,
  });
  assertEquals(w.module.priority(id), 200);
  w.module.onCanonicalityChange(id, false);
  assertEquals(w.module.priority(id), 50);
});

Deno.test('GenerationModule: uncanonical flip triggers exactly one restart', () => {
  const w = makeWorld();
  const id = w.module.startGeneration({
    targetKey: 't1',
    anchor: hashOf('a'),
    verifier: verifier('v'),
    declaredWeight: 100,
  });
  w.module.onCanonicalityChange(id, false);
  assertEquals(w.restarts.length, 1);
  assertEquals(w.restarts[0].targetKey, 't1');
  assertEquals(w.restarts[0].previousDraftId.toHex(), id.toHex());

  // Redundant "still uncanonical" notifications should not trigger more restarts.
  w.module.onCanonicalityChange(id, false);
  assertEquals(w.restarts.length, 1);
});

Deno.test('GenerationModule: flipping back to canonical does not trigger a second restart', () => {
  const w = makeWorld();
  const id = w.module.startGeneration({
    targetKey: 't1',
    anchor: hashOf('a'),
    verifier: verifier('v'),
    declaredWeight: 100,
  });
  w.module.onCanonicalityChange(id, false);
  w.module.onCanonicalityChange(id, true);
  w.module.onCanonicalityChange(id, false);
  // Two falsy flips, each should trigger one restart.
  assertEquals(w.restarts.length, 2);
  // Priority returns to full after flipping back.
  w.module.onCanonicalityChange(id, true);
  assertEquals(w.module.priority(id), 100);
});

Deno.test('GenerationModule: drafts from the same target coexist after restart', () => {
  const w = makeWorld();
  const spec: GenerationSpec = {
    targetKey: 't1',
    anchor: hashOf('a'),
    verifier: verifier('v'),
    declaredWeight: 100,
  };
  const first = w.module.startGeneration(spec);
  w.module.onCanonicalityChange(first, false);
  assertEquals(w.restarts.length, 1);

  // Simulate provider responding by calling startGeneration again.
  const second = w.module.startGeneration(spec);
  assertEquals(w.module.size, 2);
  const siblings = w.module.draftsForTarget('t1').map((h) => h.toHex());
  assert(siblings.includes(first.toHex()));
  assert(siblings.includes(second.toHex()));

  // First is deprioritized, second at full.
  assertEquals(w.module.priority(first), 10); // 100 * 0.1
  assertEquals(w.module.priority(second), 100);
});

Deno.test('GenerationModule: forget removes a draft from the registry', () => {
  const w = makeWorld();
  const id = w.module.startGeneration({
    targetKey: 't1',
    anchor: hashOf('a'),
    verifier: verifier('v'),
    declaredWeight: 100,
  });
  assertEquals(w.module.size, 1);
  w.module.forget(id);
  assertEquals(w.module.size, 0);
  // Priority on an unknown draft is 0.
  assertEquals(w.module.priority(id), 0);
});

Deno.test('GenerationModule: onCanonicalityChange on unknown draftId is a no-op', () => {
  const w = makeWorld();
  w.module.onCanonicalityChange(hashOf('deadbeef'), false);
  assertEquals(w.restarts.length, 0);
});

Deno.test('GenerationModule: priority on unknown draftId is 0', () => {
  const w = makeWorld();
  assertEquals(w.module.priority(hashOf('deadbeef')), 0);
});
