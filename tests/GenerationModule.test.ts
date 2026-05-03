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
  restarts: { previousDraftId: Hash; spec: GenerationSpec }[];
}

function makeWorld(opts: { uncanonicalFactor?: number } = {}): World {
  const restarts: { previousDraftId: Hash; spec: GenerationSpec }[] = [];
  const provider: GenerationProvider = {
    requestRestart: (prev, spec) => {
      restarts.push({ previousDraftId: prev, spec });
    },
  };
  const module = new GenerationModule(provider, opts);
  return { provider, module, restarts };
}

const baseSpec: Omit<GenerationSpec, 'targetKey'> = {
  verifier: verifier('v'),
  declaredWeight: 100,
};

// -- Tests --------------------------------------------------------

Deno.test('GenerationModule: register tracks a draft and reports priority', () => {
  const w = makeWorld();
  const id = hashOf('d1');
  w.module.register(id, { ...baseSpec, targetKey: 't1' });
  assertEquals(w.module.size, 1);
  assertEquals(w.module.priority(id), 100);
});

Deno.test('GenerationModule: priority drops to declaredWeight*factor when uncanonical', () => {
  const w = makeWorld({ uncanonicalFactor: 0.25 });
  const id = hashOf('d1');
  w.module.register(id, { ...baseSpec, targetKey: 't1', declaredWeight: 200 });
  assertEquals(w.module.priority(id), 200);
  w.module.onCanonicalityChange(id, false);
  assertEquals(w.module.priority(id), 50);
});

Deno.test('GenerationModule: uncanonical flip triggers exactly one restart', () => {
  const w = makeWorld();
  const id = hashOf('d1');
  w.module.register(id, { ...baseSpec, targetKey: 't1' });
  w.module.onCanonicalityChange(id, false);
  assertEquals(w.restarts.length, 1);
  assertEquals(w.restarts[0].spec.targetKey, 't1');
  assertEquals(w.restarts[0].previousDraftId.toHex(), id.toHex());

  w.module.onCanonicalityChange(id, false);
  assertEquals(w.restarts.length, 1);
});

Deno.test('GenerationModule: flipping back to canonical does not trigger a second restart', () => {
  const w = makeWorld();
  const id = hashOf('d1');
  w.module.register(id, { ...baseSpec, targetKey: 't1' });
  w.module.onCanonicalityChange(id, false);
  w.module.onCanonicalityChange(id, true);
  w.module.onCanonicalityChange(id, false);
  assertEquals(w.restarts.length, 2);
  w.module.onCanonicalityChange(id, true);
  assertEquals(w.module.priority(id), 100);
});

Deno.test('GenerationModule: drafts from the same target coexist after restart', () => {
  const w = makeWorld();
  const first = hashOf('d1');
  const second = hashOf('d2');
  const spec: GenerationSpec = { ...baseSpec, targetKey: 't1' };
  w.module.register(first, spec);
  w.module.onCanonicalityChange(first, false);
  assertEquals(w.restarts.length, 1);

  w.module.register(second, spec);
  assertEquals(w.module.size, 2);
  const siblings = w.module.draftsForTarget('t1').map((h) => h.toHex());
  assert(siblings.includes(first.toHex()));
  assert(siblings.includes(second.toHex()));

  assertEquals(w.module.priority(first), 10);
  assertEquals(w.module.priority(second), 100);
});

Deno.test('GenerationModule: forget removes a draft from the registry', () => {
  const w = makeWorld();
  const id = hashOf('d1');
  w.module.register(id, { ...baseSpec, targetKey: 't1' });
  assertEquals(w.module.size, 1);
  w.module.forget(id);
  assertEquals(w.module.size, 0);
  assertEquals(w.module.priority(id), 0);
});

Deno.test('GenerationModule: onCanonicalityChange on unknown draftId is a no-op', () => {
  const w = makeWorld();
  w.module.onCanonicalityChange(hashOf('dx'), false);
  assertEquals(w.restarts.length, 0);
});

Deno.test('GenerationModule: priority on unknown draftId is 0', () => {
  const w = makeWorld();
  assertEquals(w.module.priority(hashOf('dx')), 0);
});

Deno.test('GenerationModule: getSpec returns the registered spec', () => {
  const w = makeWorld();
  const id = hashOf('d1');
  const spec: GenerationSpec = { ...baseSpec, targetKey: 't1' };
  w.module.register(id, spec);
  const got = w.module.getSpec(id);
  assertEquals(got?.targetKey, 't1');
  assertEquals(got?.declaredWeight, 100);
});
