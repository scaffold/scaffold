import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import {
  AGGREGATION_CONTRACT,
  Block,
  BlockSource,
  BlockStore,
  makeAggregationOutput,
} from '../src/core/Block.ts';
import { createDraft, DraftStore } from '../src/core/BlockDraft.ts';
import { ContractGenerator } from '../src/core/ContractGenerator.ts';
import { OutputClaimModule, OutputClaimProvider } from '../src/core/OutputClaimModule.ts';
import { UtxoIndex } from '../src/node/UtxoIndex.ts';
import { type ContractFn } from '../src/core/ContractEnv.ts';
import { aggregationContract, AGGREGATION_THRESHOLD } from '../src/core/AggregationContract.ts';

// -- Helpers -------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

function makeBlock(opts: {
  name: string;
  anchor?: Hash;
  outputs?: Output[];
  claims?: number[];
}): Block {
  return {
    hash: h(opts.name),
    anchor: opts.anchor ?? ZERO_HASH,
    outputs: opts.outputs ?? [],
    claims: opts.claims ?? [],
    refs: [],
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
}

function makeTestSetup() {
  const store = new BlockStore();
  const utxoIndex = new UtxoIndex(store);
  const outputClaims = new OutputClaimModule(new TestOutputClaimProvider(store));
  const draftStore = new DraftStore();
  const contracts = new Map<string, ContractFn>();

  // Register the aggregation contract
  contracts.set(AGGREGATION_CONTRACT.toHex(), aggregationContract);

  const generator = new ContractGenerator({
    lookupContract: (hash) => contracts.get(hash.toHex()),
    store,
    utxoIndex,
    outputClaims,
    draftStore,
  });

  return { store, utxoIndex, outputClaims, draftStore, contracts, generator };
}

// -- Tests ---------------------------------------------------------

Deno.test('aggregation contract rejects when fewer than 4 inputs available', () => {
  const { store, utxoIndex, draftStore, generator } = makeTestSetup();

  // Genesis with one aggregation output
  const genesis = makeBlock({
    name: 'genesis',
    outputs: [makeAggregationOutput()],
  });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  const draft = createDraft({
    resolvedClaims: [{ block: genesis.hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  // Draft should be cancelled -- not enough inputs
  assertEquals(draftStore.get(draft.draftId), undefined);
});

Deno.test('4 blocks with aggregation outputs triggers aggregator generation', () => {
  const { store, utxoIndex, draftStore, generator } = makeTestSetup();

  // Create a genesis block (no aggregation output -- it's genesis)
  const genesis = makeBlock({ name: 'genesis' });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  // Create 4 blocks, each with an aggregation output
  const blocks: Block[] = [];
  for (let i = 0; i < AGGREGATION_THRESHOLD; i++) {
    const block = makeBlock({
      name: `block-${i}`,
      anchor: genesis.hash,
      outputs: [makeAggregationOutput()],
    });
    store.put(block);
    utxoIndex.blockBecameCanonical(block);
    blocks.push(block);
  }

  // Verify we have 4 aggregation outputs in the UTXO index
  const entries = utxoIndex.getByVerifier(AGGREGATION_CONTRACT, new Uint8Array(0));
  assertEquals(entries.length, AGGREGATION_THRESHOLD);

  // Create a draft claiming the first block's aggregation output.
  // The aggregation contract will call requireInput() 4 times,
  // consuming all 4 aggregation outputs.
  const draft = createDraft({
    resolvedClaims: [{ block: blocks[0].hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  // Draft should be ready -- aggregation contract succeeded
  const updated = draftStore.get(draft.draftId)!;
  assert(updated, 'draft should exist after successful generation');
  assertEquals(updated.status, 'ready');

  // The contract consumed 4 inputs via requireInput(). The first call
  // re-found the trigger claim (blocks[0]:0) which is deduplicated on merge.
  // Final: trigger (1) + 3 new from requireInput() = 4 total.
  assertEquals(updated.resolvedClaims.length, AGGREGATION_THRESHOLD);

  // All resolved claims should reference distinct blocks
  const claimedBlocks = new Set(
    updated.resolvedClaims.map((rc) => rc.block.toPrimitive()),
  );
  assertEquals(claimedBlocks.size, AGGREGATION_THRESHOLD);
});

Deno.test('3 blocks are not enough to trigger aggregator', () => {
  const { store, utxoIndex, draftStore, generator } = makeTestSetup();

  const genesis = makeBlock({ name: 'genesis' });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  // Only 3 blocks -- one short of the threshold
  for (let i = 0; i < AGGREGATION_THRESHOLD - 1; i++) {
    const block = makeBlock({
      name: `block-${i}`,
      anchor: genesis.hash,
      outputs: [makeAggregationOutput()],
    });
    store.put(block);
    utxoIndex.blockBecameCanonical(block);
  }

  const entries = utxoIndex.getByVerifier(AGGREGATION_CONTRACT, new Uint8Array(0));
  assertEquals(entries.length, AGGREGATION_THRESHOLD - 1);

  // Create a draft claiming one aggregation output
  const firstBlock = store.get(h('block-0'))!;
  const draft = createDraft({
    resolvedClaims: [{ block: firstBlock.hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  // Draft should be cancelled -- not enough inputs
  assertEquals(draftStore.get(draft.draftId), undefined);
});

Deno.test('merged resolvedClaims contain no duplicates', () => {
  const { store, utxoIndex, draftStore, generator } = makeTestSetup();

  const genesis = makeBlock({ name: 'genesis' });
  store.put(genesis);
  utxoIndex.blockBecameCanonical(genesis);

  // Create exactly 4 blocks
  const blocks: Block[] = [];
  for (let i = 0; i < AGGREGATION_THRESHOLD; i++) {
    const block = makeBlock({
      name: `block-${i}`,
      anchor: genesis.hash,
      outputs: [makeAggregationOutput()],
    });
    store.put(block);
    utxoIndex.blockBecameCanonical(block);
    blocks.push(block);
  }

  const draft = createDraft({
    resolvedClaims: [{ block: blocks[0].hash, outputIndex: 0, value: 0 }],
    outputs: [],
    declaredWeight: 1,
    anchor: genesis.hash,
  });
  draftStore.add(draft);
  draftStore.transition(draft.draftId, 'generating');

  generator.generate(draft);

  const updated = draftStore.get(draft.draftId)!;
  assert(updated, 'draft should exist');

  // After merge, all resolved claims should be distinct (block, outputIndex) pairs.
  // The trigger claim (blocks[0]:0) that requireInput() re-found is deduplicated.
  const seen = new Set<string>();
  for (const rc of updated.resolvedClaims) {
    const key = `${rc.block.toPrimitive()}:${rc.outputIndex}`;
    assertEquals(seen.has(key), false, `duplicate claim: ${key}`);
    seen.add(key);
  }
  assertEquals(updated.resolvedClaims.length, AGGREGATION_THRESHOLD);
});
