import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { ConsensusModule, ConsensusProvider } from '../src/core/ConsensusModule.ts';
import { CollateralSide, TrustModule, TrustProvider } from '../src/core/TrustModule.ts';

// -- Consensus test helpers ------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  aggregates: Hash[];
  weight: number[];
}

class TestConsensusProvider implements ConsensusProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  getHash(block: TestBlock): Hash {
    return block.hash;
  }

  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }

  getAggregates(block: TestBlock): Hash[] {
    return block.aggregates;
  }

  getWeightVector(block: TestBlock): number[] {
    return block.weight;
  }
}

const h = (name: string): Hash => Hash.digest(name);

// -- ConsensusModule listener tests ----------------------------------

Deno.test('ConsensusModule: listener fires on canonicality flip', () => {
  const provider = new TestConsensusProvider();
  const consensus = new ConsensusModule(provider);

  const genesis: TestBlock = { hash: h('gen'), anchor: ZERO_HASH, aggregates: [], weight: [100] };
  provider.add(genesis);
  consensus.addBlock(genesis.hash);
  consensus.setVerifiedWeight(genesis.hash, genesis.weight);

  // Initialize snapshot
  consensus.flushChanges();

  const changes: { hash: string; canonical: boolean }[] = [];
  consensus.onCanonicalityChange((hash, canonical) => {
    changes.push({ hash: hash.toHex(), canonical });
  });

  // Add a block that anchors to genesis
  const blockA: TestBlock = { hash: h('A'), anchor: h('gen'), aggregates: [], weight: [10] };
  provider.add(blockA);
  consensus.addBlock(blockA.hash);
  consensus.setVerifiedWeight(blockA.hash, blockA.weight);

  consensus.flushChanges();

  // blockA should be newly canonical
  assertEquals(changes.length, 1);
  assertEquals(changes[0].hash, h('A').toHex());
  assertEquals(changes[0].canonical, true);
});

Deno.test('ConsensusModule: listener fires when block becomes non-canonical', () => {
  const provider = new TestConsensusProvider();
  const consensus = new ConsensusModule(provider);

  const genesis: TestBlock = { hash: h('gen'), anchor: ZERO_HASH, aggregates: [], weight: [100] };
  provider.add(genesis);
  consensus.addBlock(genesis.hash);
  consensus.setVerifiedWeight(genesis.hash, genesis.weight);

  const blockA: TestBlock = { hash: h('A'), anchor: h('gen'), aggregates: [], weight: [5] };
  provider.add(blockA);
  consensus.addBlock(blockA.hash);
  consensus.setVerifiedWeight(blockA.hash, blockA.weight);

  // Initialize snapshot with genesis + blockA canonical
  consensus.flushChanges();

  const changes: { hash: string; canonical: boolean }[] = [];
  consensus.onCanonicalityChange((hash, canonical) => {
    changes.push({ hash: hash.toHex(), canonical });
  });

  // Add a conflicting block that beats blockA
  const blockB: TestBlock = { hash: h('B'), anchor: h('gen'), aggregates: [], weight: [50] };
  provider.add(blockB);
  consensus.addBlock(blockB.hash);
  consensus.setVerifiedWeight(blockB.hash, blockB.weight);
  consensus.addConflict(blockA.hash, blockB.hash);

  consensus.flushChanges();

  // blockB became canonical, blockA became non-canonical
  const aChange = changes.find((c) => c.hash === h('A').toHex());
  const bChange = changes.find((c) => c.hash === h('B').toHex());
  assert(aChange);
  assertFalse(aChange!.canonical);
  assert(bChange);
  assert(bChange!.canonical);
});

Deno.test('ConsensusModule: flushChanges does not fire when nothing changed', () => {
  const provider = new TestConsensusProvider();
  const consensus = new ConsensusModule(provider);

  const genesis: TestBlock = { hash: h('gen'), anchor: ZERO_HASH, aggregates: [], weight: [100] };
  provider.add(genesis);
  consensus.addBlock(genesis.hash);
  consensus.setVerifiedWeight(genesis.hash, genesis.weight);

  // Initialize snapshot
  consensus.flushChanges();

  let callCount = 0;
  consensus.onCanonicalityChange(() => {
    callCount++;
  });

  // Flush again with no changes
  consensus.flushChanges();
  assertEquals(callCount, 0);
});

// -- TrustModule listener tests --------------------------------------

interface TestTrustBlock {
  hash: Hash;
  anchor: Hash;
  declaredWeight: number;
  childWeights: number[];
}

class TestTrustProvider implements TrustProvider<TestTrustBlock> {
  private blocks = new Map<HashPrimitive, TestTrustBlock>();
  canonicalBlocks = new Set<HashPrimitive>();
  aggregatedBlocks = new Set<HashPrimitive>();

  add(block: TestTrustBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
  }

  getBlock(hash: Hash): TestTrustBlock | undefined {
    return this.blocks.get(hash.toPrimitive());
  }

  getAnchor(block: TestTrustBlock): Hash {
    return block.anchor;
  }

  getDeclaredWeight(block: TestTrustBlock): number {
    return block.declaredWeight;
  }

  getChildDeclaredWeight(block: TestTrustBlock, childIndex: number): number {
    return block.childWeights[childIndex] ?? 0;
  }

  isAggregated(hash: Hash): boolean {
    return this.aggregatedBlocks.has(hash.toPrimitive());
  }

  isCanonical(hash: Hash): boolean {
    return this.canonicalBlocks.has(hash.toPrimitive());
  }

  isAncestor(_ancestor: Hash, _descendant: Hash): boolean {
    return false;
  }
}

Deno.test('TrustModule: listener fires on addCollateral', () => {
  const provider = new TestTrustProvider();
  const trust = new TrustModule(provider);

  const target: TestTrustBlock = {
    hash: h('target'),
    anchor: ZERO_HASH,
    declaredWeight: 100,
    childWeights: [],
  };
  const collateral: TestTrustBlock = {
    hash: h('collateral'),
    anchor: ZERO_HASH,
    declaredWeight: 10,
    childWeights: [],
  };
  provider.add(target);
  provider.add(collateral);

  const notifications: string[] = [];
  trust.onCollateralChange((targetHash) => {
    notifications.push(targetHash.toHex());
  });

  trust.addCollateral(collateral.hash, target.hash, CollateralSide.For, [], 50);

  assertEquals(notifications.length, 1);
  assertEquals(notifications[0], h('target').toHex());
});

Deno.test('TrustModule: listener fires on redeemCollateral', () => {
  const provider = new TestTrustProvider();
  const trust = new TrustModule(provider);

  const target: TestTrustBlock = {
    hash: h('target'),
    anchor: ZERO_HASH,
    declaredWeight: 100,
    childWeights: [],
  };
  const collateral: TestTrustBlock = {
    hash: h('collateral'),
    anchor: ZERO_HASH,
    declaredWeight: 10,
    childWeights: [],
  };
  provider.add(target);
  provider.add(collateral);

  trust.addCollateral(collateral.hash, target.hash, CollateralSide.For, [], 50);
  provider.aggregatedBlocks.add(target.hash.toPrimitive());

  const notifications: string[] = [];
  trust.onCollateralChange((targetHash) => {
    notifications.push(targetHash.toHex());
  });

  trust.redeemCollateral(collateral.hash);

  assertEquals(notifications.length, 1);
  assertEquals(notifications[0], h('target').toHex());
});

Deno.test('TrustModule: listener fires on claimCollateral', () => {
  const provider = new TestTrustProvider();
  const trust = new TrustModule(provider);

  const target: TestTrustBlock = {
    hash: h('target'),
    anchor: ZERO_HASH,
    declaredWeight: 100,
    childWeights: [],
  };
  provider.add(target);

  // Add FOR and AGAINST collateral
  const forC: TestTrustBlock = {
    hash: h('for'),
    anchor: ZERO_HASH,
    declaredWeight: 10,
    childWeights: [],
  };
  const againstC: TestTrustBlock = {
    hash: h('against'),
    anchor: ZERO_HASH,
    declaredWeight: 10,
    childWeights: [],
  };
  provider.add(forC);
  provider.add(againstC);

  trust.addCollateral(forC.hash, target.hash, CollateralSide.For, [], 50);
  trust.addCollateral(againstC.hash, target.hash, CollateralSide.Against, [], 30);

  const notifications: string[] = [];
  trust.onCollateralChange((targetHash) => {
    notifications.push(targetHash.toHex());
  });

  // Claim as FOR winning
  trust.claimCollateral(target.hash, [], CollateralSide.For, 1);

  assertEquals(notifications.length, 1);
  assertEquals(notifications[0], h('target').toHex());
});
