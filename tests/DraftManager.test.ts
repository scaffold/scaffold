import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { DraftStore } from '../src/core/Draft.ts';
import { DraftManager } from '../src/core/DraftManager.ts';
import { StubGenerator } from '../src/core/Generator.ts';
import { ConsensusModule, ConsensusProvider } from '../src/core/ConsensusModule.ts';
import { Draft } from '../src/core/Draft.ts';

// -- Test helpers ------------------------------------------------

/** Minimal entity type for consensus: either a real test block or a draft. */
type TestEntity = { kind: 'block'; hash: Hash; anchor: Hash; weight: number[] } | Draft;

function isBlockDraft(e: TestEntity): e is Draft {
  return 'draftId' in e;
}

class TestProvider implements ConsensusProvider<TestEntity> {
  private blocks = new Map<HashPrimitive, TestEntity>();
  private draftStore?: DraftStore;

  add(entity: TestEntity): void {
    const key = isBlockDraft(entity) ? entity.draftId.toPrimitive() : entity.hash.toPrimitive();
    this.blocks.set(key, entity);
  }

  setDraftStore(ds: DraftStore): void {
    this.draftStore = ds;
  }

  getBlock(hash: Hash): TestEntity | undefined {
    return this.blocks.get(hash.toPrimitive()) ?? this.draftStore?.get(hash);
  }

  getHash(entity: TestEntity): Hash {
    return isBlockDraft(entity) ? entity.draftId : entity.hash;
  }

  getAnchor(entity: TestEntity): Hash {
    return isBlockDraft(entity) ? entity.anchor : entity.anchor;
  }

  getAggregates(entity: TestEntity): Hash[] {
    return isBlockDraft(entity) ? entity.aggregates : [];
  }

  getWeightVector(entity: TestEntity): number[] {
    return isBlockDraft(entity) ? [entity.declaredWeight] : entity.weight;
  }
}

const h = (name: string): Hash => Hash.digest(name);

function setupConsensus() {
  const provider = new TestProvider();
  const consensus = new ConsensusModule(provider);
  const draftStore = new DraftStore();
  const generator = new StubGenerator();

  provider.setDraftStore(draftStore);

  const manager = new DraftManager(draftStore, consensus, generator);

  return { provider, consensus, draftStore, generator, manager };
}

// -- DraftManager lifecycle tests ---------------------------------

Deno.test('createDraft: stores draft, registers in consensus, starts generator', () => {
  const { manager, draftStore, consensus, generator } = setupConsensus();
  const { provider } = setupConsensus();

  // Set up genesis
  const ctx = setupWithGenesis();

  const draft = ctx.manager.createDraft({
    claims: [{ producer: h('b'), outputIndex: 0 }],
    outputs: [],
    declaredWeight: 10,
    anchor: ctx.genesis.hash,
  });

  // Draft is in store
  const stored = ctx.draftStore.get(draft.draftId);
  assert(stored !== undefined);
  assertEquals(stored!.status, 'generating');

  // Draft registered in consensus
  assert(ctx.consensus.isCanonical(draft.draftId));

  // Generator was called
  assert(ctx.generator.active.has(draft.draftId.toPrimitive()));
});

Deno.test('draft weight propagates to anchor chain', () => {
  const ctx = setupWithGenesis();

  const draft = ctx.manager.createDraft({
    claims: [],
    outputs: [],
    declaredWeight: 42,
    anchor: ctx.genesis.hash,
  });

  // Genesis effective weight should include draft's weight
  const genesisWeight = ctx.consensus.getEffectiveWeight(ctx.genesis.hash);
  assert(genesisWeight >= 42, `genesis effective weight ${genesisWeight} should include draft`);
});

Deno.test('draft canonicality: draftId appears in canonical view', () => {
  const ctx = setupWithGenesis();

  const draft = ctx.manager.createDraft({
    claims: [],
    outputs: [],
    declaredWeight: 10,
    anchor: ctx.genesis.hash,
  });

  const canonical = ctx.consensus.getCanonicalView();
  assert(canonical.has(draft.draftId.toPrimitive()));
});

Deno.test('cancelDraft: removes from consensus, cancels generator, removes from store', () => {
  const ctx = setupWithGenesis();

  const draft = ctx.manager.createDraft({
    claims: [],
    outputs: [],
    declaredWeight: 10,
    anchor: ctx.genesis.hash,
  });

  ctx.manager.cancelDraft(draft.draftId);

  // Removed from consensus
  const canonical = ctx.consensus.getCanonicalView();
  assertFalse(canonical.has(draft.draftId.toPrimitive()));

  // Generator cancelled
  assert(ctx.generator.cancelled.has(draft.draftId.toPrimitive()));
  assertFalse(ctx.generator.active.has(draft.draftId.toPrimitive()));

  // Removed from store
  assertEquals(ctx.draftStore.get(draft.draftId), undefined);
});

// Margin-based draft cancellation is intentionally removed; canonicality-
// driven deprioritization in GenerationModule + anchor-chain Rule 1/2 in
// ConsensusModule cover the same ground more strictly. See
// docs/protocol/draft-blocks.md#generation-deprioritization-and-restart.

Deno.test('recreation: cancel old draft, create new -- no double-counting', () => {
  const ctx = setupWithGenesis();

  const draft1 = ctx.manager.createDraft({
    claims: [],
    outputs: [],
    declaredWeight: 20,
    anchor: ctx.genesis.hash,
  });

  const weightBefore = ctx.consensus.getEffectiveWeight(ctx.genesis.hash);

  // Cancel old, create new
  ctx.manager.cancelDraft(draft1.draftId);
  const draft2 = ctx.manager.createDraft({
    claims: [],
    outputs: [],
    declaredWeight: 20,
    anchor: ctx.genesis.hash,
  });

  const weightAfter = ctx.consensus.getEffectiveWeight(ctx.genesis.hash);

  // Weight should be the same -- no double-counting
  assertEquals(weightBefore, weightAfter);
});

// -- Helper: setup with genesis -----------------------------------

function setupWithGenesis() {
  const provider = new TestProvider();
  const consensus = new ConsensusModule(provider);
  const draftStore = new DraftStore();
  const generator = new StubGenerator();

  provider.setDraftStore(draftStore);

  // Register genesis
  const genesis: TestEntity = {
    kind: 'block',
    hash: h('genesis'),
    anchor: ZERO_HASH,
    weight: [],
  };
  provider.add(genesis);
  consensus.addBlock(genesis.hash);

  const manager = new DraftManager(draftStore, consensus, generator);

  return { provider, consensus, draftStore, generator, manager, genesis };
}
