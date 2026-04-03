import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  Block,
  BlockSource,
  BlockStore,
  RESULT_CONTRACT,
  createSelfClaimedOutput,
} from '../src/core/Block.ts';
import { createDraft, DraftStore, ResolvedClaim } from '../src/core/BlockDraft.ts';
import { ContractGenerator } from '../src/core/ContractGenerator.ts';
import { OutputClaimModule, OutputClaimProvider } from '../src/core/OutputClaimModule.ts';
import { UtxoIndex } from '../src/node/UtxoIndex.ts';
import { type ContractEnv, ContractRejection } from '../src/core/ContractEnv.ts';
import type { Contract } from '../src/core/Contract.ts';

// -- Helpers -------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const SIG_CONTRACT = h('signature-contract');

function makeSignatureVerifier(pubkey: Uint8Array): Verifier {
  return { contract: SIG_CONTRACT, params: pubkey };
}

function makeBlock(opts: {
  name: string;
  anchor?: Hash;
  outputs?: Output[];
  claims?: number[];
  refs?: Hash[];
}): Block {
  return {
    hash: h(opts.name),
    anchor: opts.anchor ?? ZERO_HASH,
    outputs: opts.outputs ?? [],
    claims: opts.claims ?? [],
    refs: opts.refs ?? [],
    aggregates: [],
    declaredWeight: 1,
    timestamp: Date.now(),
    receivedAt: Date.now(),
    source: BlockSource.Local,
  };
}

class TestOutputClaimProvider implements OutputClaimProvider<Block> {
  constructor(private readonly store: BlockStore) {}
  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }
  getHash(block: Block): Hash {
    return block.hash;
  }
  getAnchor(block: Block): Hash {
    return block.anchor;
  }
  getOwnOutputCount(block: Block): number {
    return block.outputs.length;
  }
  getAggregateHashes(block: Block): Hash[] {
    return block.aggregates;
  }
  getAggregateOutputCounts(_block: Block): number[] {
    return [];
  }
  getSubtreeClaimMask(_block: Block): readonly number[] {
    return [];
  }
}

function makeTestSetup() {
  const store = new BlockStore();
  const utxoIndex = new UtxoIndex(store);
  const outputClaims = new OutputClaimModule(new TestOutputClaimProvider(store));
  const draftStore = new DraftStore();
  const contracts = new Map<string, Contract>();

  const generator = new ContractGenerator({
    lookupContract: (hash) => contracts.get(hash.toHex()),
    store,
    utxoIndex,
    outputClaims,
    draftStore,
  });

  return { store, utxoIndex, outputClaims, draftStore, contracts, generator };
}

// -- Tests: basic generation ---------------------------------------

Deno.test('ContractGenerator: runs contract and populates draft', () => {
  const { store, utxoIndex, draftStore, contracts, generator } = makeTestSetup();

  const gameContract = h('game-contract');
  const gameVerifier: Verifier = { contract: gameContract, params: enc('cfg') };

  // Register a contract that produces a result output
  contracts.set(gameContract.toHex(), {
    run(env: ContractEnv) {
      env.requireResult(enc('state'), enc('new-state'));
      env.requireOutput({ contract: SIG_CONTRACT, params: enc('pk') }, 10);
    },
  });

  // Create a genesis block with a game output
  const genesis = makeBlock({
    name: 'genesis',
    outputs: [{ verifier: gameVerifier, value: 0, data: enc('init') }],
  });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  // Create a draft claiming the game output
  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  // Run generation
  generator.generate(draft);

  // Draft should be ready with outputs populated
  const updated = draftStore.get(draft.draftId)!;
  assert(updated, 'draft should exist');
  assertEquals(updated.status, 'ready');
  assertEquals(updated.outputs.length, 2); // result + sig output
  assert(Hash.equals(updated.outputs[0].verifier.contract, RESULT_CONTRACT));
  assertEquals(updated.outputs[1].value, 10);
});

Deno.test('ContractGenerator: contract rejection cancels draft', () => {
  const { store, utxoIndex, draftStore, contracts, generator } = makeTestSetup();

  const gameContract = h('reject-contract');
  const gameVerifier: Verifier = { contract: gameContract, params: enc('cfg') };

  contracts.set(gameContract.toHex(), {
    run(_env: ContractEnv) {
      throw new ContractRejection('nope');
    },
  });

  const genesis = makeBlock({
    name: 'genesis',
    outputs: [{ verifier: gameVerifier, value: 0, data: enc('init') }],
  });
  store.put(genesis);

  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  // Draft should be cancelled
  const updated = draftStore.get(draft.draftId);
  assertEquals(updated, undefined); // cancelled drafts are removed
});

Deno.test('ContractGenerator: cancel handle removes claims', () => {
  const { store, utxoIndex, outputClaims, draftStore, contracts, generator } = makeTestSetup();

  const gameContract = h('game-with-inputs');
  const gameVerifier: Verifier = { contract: gameContract, params: enc('cfg') };
  const sigVerifier = makeSignatureVerifier(enc('pk'));

  // Contract that consumes an input
  contracts.set(gameContract.toHex(), {
    run(env: ContractEnv) {
      env.collectInputs();
      env.requireResult(enc('state'), enc('done'));
    },
  });

  // Genesis with a game output and a sig output
  const genesis = makeBlock({
    name: 'genesis',
    outputs: [
      { verifier: gameVerifier, value: 5, data: enc('data') },
      { verifier: sigVerifier, value: 10, data: new Uint8Array(0) },
    ],
  });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 0, value: 5 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  const handle = generator.generate(draft);

  // The contract consumed the game input -- verify claim is registered
  const claimants = outputClaims.getClaimantsAt(genesis.hash, 0);
  assert(claimants && claimants.length > 0, 'should have claim registered');

  // Cancel the draft -- claims should be removed
  handle.cancel();
  const afterCancel = outputClaims.getClaimantsAt(genesis.hash, 0);
  assert(!afterCancel || afterCancel.length === 0, 'claims should be removed after cancel');
});

Deno.test('ContractGenerator: findInputs filters already-claimed outputs', () => {
  const { store, utxoIndex, outputClaims, draftStore, contracts, generator } = makeTestSetup();

  const gameContract = h('game-filter');
  const gameVerifier: Verifier = { contract: gameContract, params: enc('cfg') };

  // Contract that collects all inputs and reports how many
  let inputCount = 0;
  contracts.set(gameContract.toHex(), {
    run(env: ContractEnv) {
      const inputs = env.collectInputs() as { value: number }[];
      inputCount = inputs.length;
      env.requireResult(enc('count'), enc(String(inputs.length)));
    },
  });

  // Genesis with two game outputs
  const genesis = makeBlock({
    name: 'genesis',
    outputs: [
      { verifier: gameVerifier, value: 5, data: enc('a') },
      { verifier: gameVerifier, value: 10, data: enc('b') },
    ],
  });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  // Pre-claim the first output via OutputClaimModule
  outputClaims.addClaim(h('other-draft'), genesis.hash, 0);

  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 1, value: 10 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  // Only the unclaimed output (index 1) should be found
  assertEquals(inputCount, 1);
});

Deno.test('ContractGenerator: resolved claims from inputs are merged into draft', () => {
  const { store, utxoIndex, draftStore, contracts, generator } = makeTestSetup();

  const gameContract = h('game-claims');
  const gameVerifier: Verifier = { contract: gameContract, params: enc('cfg') };

  contracts.set(gameContract.toHex(), {
    run(env: ContractEnv) {
      env.requireInput();
      env.requireResult(enc('state'), enc('done'));
    },
  });

  const genesis = makeBlock({
    name: 'genesis',
    outputs: [
      { verifier: gameVerifier, value: 7, data: enc('data') },
    ],
  });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  const initialClaim: ResolvedClaim = { block: genesis.hash, outputIndex: 0, value: 7 };
  const draft = createDraft({
    resolvedClaims: [initialClaim],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  const updated = draftStore.get(draft.draftId)!;
  assertEquals(updated.status, 'ready');
  // requireInput() re-found the trigger claim (genesis:0) which is
  // deduplicated on merge, so only the original trigger claim remains.
  assertEquals(updated.resolvedClaims.length, 1);
  assert(Hash.equals(updated.resolvedClaims[0].block, genesis.hash));
});

Deno.test('ContractGenerator: fetch adds refs to draft', () => {
  const { store, utxoIndex, draftStore, contracts, generator } = makeTestSetup();

  const gameContract = h('game-fetch');
  const gameVerifier: Verifier = { contract: gameContract, params: enc('cfg') };

  // A block that claims the game verifier and has a result
  const prevAnchor = makeBlock({
    name: 'prev-anchor',
    outputs: [{ verifier: gameVerifier, value: 0, data: new Uint8Array(0) }],
  });
  store.put(prevAnchor);

  const prevBlock = makeBlock({
    name: 'prev-block',
    anchor: prevAnchor.hash,
    outputs: [createSelfClaimedOutput('state', enc('S0'))],
    claims: [1], // claims the game output from prev-anchor
  });
  store.put(prevBlock);

  // Genesis has a triggering output
  const genesis = makeBlock({
    name: 'genesis',
    outputs: [{ verifier: gameVerifier, value: 0, data: enc('trigger') }],
  });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  // Contract that fetches state from prev block
  contracts.set(gameContract.toHex(), {
    run(env: ContractEnv) {
      const state = env.fetch(gameVerifier, enc('state'));
      env.requireResult(enc('state'), state as Uint8Array);
    },
  });

  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  const updated = draftStore.get(draft.draftId)!;
  assertEquals(updated.status, 'ready');
  assertEquals(updated.refs.length, 1);
  assert(Hash.equals(updated.refs[0], prevBlock.hash));
});

Deno.test('ContractGenerator: no claims draft transitions to ready', () => {
  const { draftStore, generator } = makeTestSetup();

  const draft = createDraft({
    resolvedClaims: [],
    outputs: [],
    declaredWeight: 1,
    anchor: ZERO_HASH,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  const updated = draftStore.get(draft.draftId)!;
  assertEquals(updated.status, 'ready');
});

Deno.test('ContractGenerator: missing contract cancels draft', () => {
  const { store, draftStore, generator } = makeTestSetup();

  const unknownContract = h('unknown');
  const genesis = makeBlock({
    name: 'genesis',
    outputs: [{ verifier: { contract: unknownContract, params: new Uint8Array(0) }, value: 0, data: new Uint8Array(0) }],
  });
  store.put(genesis);

  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  // Draft should be cancelled (removed from store)
  assertEquals(draftStore.get(draft.draftId), undefined);
});
