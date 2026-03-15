import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash, HashPrimitive, ZERO_HASH } from '../src/util/Hash.ts';
import { BitVector } from '../src/core/BitVector.ts';
import {
  BlockCreationModule,
  BlockCreationProvider,
  BlockSpec,
  ClaimEntry,
  Output,
  SubtreeInfo,
} from '../src/core/BlockCreationModule.ts';
import { AGGREGATION_CONTRACT, decodeAggregationData } from '../src/core/Block.ts';

// -- Test helpers ------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputCount: number;
  weightVector: number[];
}

class TestProvider implements BlockCreationProvider<TestBlock> {
  private blocks = new Map<HashPrimitive, TestBlock>();
  /** Pre-configured anchor depths: key = `${from}:${ancestor}` */
  private anchorDepths = new Map<string, number>();
  /** Pre-configured rebased claim masks: key = `${blockHash}:${targetAnchor}` */
  private rebasedMasks = new Map<string, BitVector | null>();

  add(block: TestBlock): void {
    this.blocks.set(block.hash.toPrimitive(), block);
  }

  setAnchorDepth(from: Hash, ancestor: Hash, depth: number): void {
    this.anchorDepths.set(`${from.toPrimitive()}:${ancestor.toPrimitive()}`, depth);
  }

  setRebasedClaimMask(blockHash: Hash, targetAnchor: Hash, mask: BitVector | null): void {
    this.rebasedMasks.set(`${blockHash.toPrimitive()}:${targetAnchor.toPrimitive()}`, mask);
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

  getOutputCount(block: TestBlock): number {
    return block.outputCount;
  }

  getWeightVector(block: TestBlock): number[] {
    return block.weightVector;
  }

  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined {
    return this.anchorDepths.get(`${from.toPrimitive()}:${ancestor.toPrimitive()}`);
  }

  getRebasedClaimMask(blockHash: Hash, targetAnchor: Hash): BitVector | null {
    const key = `${blockHash.toPrimitive()}:${targetAnchor.toPrimitive()}`;
    const result = this.rebasedMasks.get(key);
    return result === undefined ? null : result;
  }

  getAggregationContract(): Hash {
    return AGGREGATION_CONTRACT;
  }
}

const h = (name: string): Hash => Hash.digest(name);

function makeOutput(value: number, contractName?: string): Output {
  return {
    verifier: { contract: contractName ? h(contractName) : h('default-contract'), params: new Uint8Array(0) },
    value,
    detail: new Uint8Array(),
  };
}

function setupModule(): { provider: TestProvider; module: BlockCreationModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new BlockCreationModule(provider);
  return { provider, module };
}

/** Extract aggregation data from a blueprint's outputs. */
function getAggData(outputs: Output[]) {
  const aggOutput = outputs.find((o) => Hash.equals(o.verifier.contract, AGGREGATION_CONTRACT));
  if (!aggOutput) return null;
  return decodeAggregationData(aggOutput.detail);
}

// -- deriveWeightVector tests ------------------------------------

Deno.test('deriveWeightVector: leaf block', () => {
  const { module } = setupModule();
  const result = module.deriveWeightVector(42, []);
  assertEquals(result, [42]);
});

Deno.test('deriveWeightVector: leaf block with zero weight', () => {
  const { module } = setupModule();
  const result = module.deriveWeightVector(0, []);
  assertEquals(result, [0]);
});

Deno.test('deriveWeightVector: single subtree at depth 0', () => {
  const { module } = setupModule();
  const subtrees: SubtreeInfo[] = [
    { anchorDepth: 0, weightVector: [10, 20] },
  ];
  // weight[0] = declaredWeight(5) + Si.weight[0](10) = 15
  // weight[1] = 0 + Si.weight[1](20) = 20
  const result = module.deriveWeightVector(5, subtrees);
  assertEquals(result, [15, 20]);
});

Deno.test('deriveWeightVector: single subtree at depth 1', () => {
  const { module } = setupModule();
  const subtrees: SubtreeInfo[] = [
    { anchorDepth: 1, weightVector: [10, 20] },
  ];
  // weight[0] = declaredWeight(5) + nothing = 5
  // weight[1] = 0 + Si.weight[0](10) = 10
  // weight[2] = 0 + Si.weight[1](20) = 20
  const result = module.deriveWeightVector(5, subtrees);
  assertEquals(result, [5, 10, 20]);
});

Deno.test('deriveWeightVector: multiple subtrees at different depths', () => {
  const { module } = setupModule();
  const subtrees: SubtreeInfo[] = [
    { anchorDepth: 0, weightVector: [10] },
    { anchorDepth: 1, weightVector: [30, 40] },
    { anchorDepth: 0, weightVector: [5, 15] },
  ];
  // weight[0] = declaredWeight(3) + S0.w[0](10) + S2.w[0](5) = 18
  // weight[1] = 0 + S1.w[0](30) + S2.w[1](15) = 45
  // weight[2] = 0 + S1.w[1](40) = 40
  const result = module.deriveWeightVector(3, subtrees);
  assertEquals(result, [18, 45, 40]);
});

Deno.test('deriveWeightVector: subtrees with varying vector lengths', () => {
  const { module } = setupModule();
  const subtrees: SubtreeInfo[] = [
    { anchorDepth: 0, weightVector: [10, 20, 30] },
    { anchorDepth: 2, weightVector: [5] },
  ];
  // weight[0] = 1 + 10 = 11
  // weight[1] = 0 + 20 = 20
  // weight[2] = 0 + 30 + 5 = 35
  const result = module.deriveWeightVector(1, subtrees);
  assertEquals(result, [11, 20, 35]);
});

// -- validateThroughput tests ------------------------------------

Deno.test('validateThroughput: balanced inputs and outputs', () => {
  const { module } = setupModule();
  const claims: ClaimEntry[] = [
    { index: 2, value: 100 },
  ];
  const outputs: Output[] = [makeOutput(100)];
  module.validateThroughput(claims, outputs, 1); // should not throw
});

Deno.test('validateThroughput: multiple inputs and outputs', () => {
  const { module } = setupModule();
  const claims: ClaimEntry[] = [
    { index: 1, value: 60 },
    { index: 2, value: 40 },
  ];
  const outputs: Output[] = [makeOutput(70), makeOutput(30)];
  // claims index 1 < ownOutputCount(2) → self-claim
  // claims index 2 >= ownOutputCount(2) → anchor claim
  // self-claim: value 60, self-claimed output[1] value 30... mismatch
  assertThrows(() => module.validateThroughput(claims, outputs, 2));
});

Deno.test('validateThroughput: balanced with self-claims', () => {
  const { module } = setupModule();
  // 2 outputs, ownOutputCount = 2
  // Self-claim on index 0 (value 50), anchor claim on index 2 (value 100)
  const claims: ClaimEntry[] = [
    { index: 0, value: 50 }, // self-claim
    { index: 2, value: 100 }, // anchor claim
  ];
  const outputs: Output[] = [
    makeOutput(50), // self-claimed → nets to zero
    makeOutput(100), // non-self-claimed → must balance with anchor claims
  ];
  module.validateThroughput(claims, outputs, 2); // should not throw
});

Deno.test('validateThroughput: imbalanced (inputs > outputs)', () => {
  const { module } = setupModule();
  const claims: ClaimEntry[] = [
    { index: 1, value: 100 },
  ];
  const outputs: Output[] = [makeOutput(50)];
  assertThrows(
    () => module.validateThroughput(claims, outputs, 1),
    Error,
    'throughput imbalance',
  );
});

Deno.test('validateThroughput: imbalanced (outputs > inputs)', () => {
  const { module } = setupModule();
  const claims: ClaimEntry[] = [
    { index: 1, value: 50 },
  ];
  const outputs: Output[] = [makeOutput(100)];
  assertThrows(() => module.validateThroughput(claims, outputs, 1));
});

Deno.test('validateThroughput: no claims no outputs', () => {
  const { module } = setupModule();
  module.validateThroughput([], [], 0); // should not throw
});

Deno.test('validateThroughput: self-claim value mismatch', () => {
  const { module } = setupModule();
  const claims: ClaimEntry[] = [
    { index: 0, value: 50 }, // self-claim
  ];
  const outputs: Output[] = [
    makeOutput(30), // self-claimed but different value
  ];
  assertThrows(
    () => module.validateThroughput(claims, outputs, 1),
    Error,
    'self-claim',
  );
});

// -- computeOutputCount tests ------------------------------------

Deno.test('computeOutputCount: leaf block', () => {
  const { module } = setupModule();
  // anchorOutputCount=10, no subtrees, 3 outputs, 1 claim
  const result = module.computeOutputCount(10, 0, 0, 3, 1);
  // 10 - 0 + 0 + 3 - 1 = 12
  assertEquals(result, 12);
});

Deno.test('computeOutputCount: aggregation block', () => {
  const { module } = setupModule();
  // anchorOutputCount=10, subtrees claim 3 anchor outputs and produce 5 new outputs
  // block itself produces 1 output and makes 2 claims
  const result = module.computeOutputCount(10, 3, 5, 1, 2);
  // 10 - 3 + 5 + 1 - 2 = 11
  assertEquals(result, 11);
});

Deno.test('computeOutputCount: no outputs no claims', () => {
  const { module } = setupModule();
  const result = module.computeOutputCount(10, 0, 0, 0, 0);
  assertEquals(result, 10);
});

// -- computeClaimMask tests --------------------------------------

Deno.test('computeClaimMask: no subtrees, single anchor claim', () => {
  const { module } = setupModule();
  const anchorOutputCount = 5;
  const mergedSubtreeMask = BitVector.empty(anchorOutputCount);
  const mask = module.computeClaimMask(anchorOutputCount, mergedSubtreeMask, [1], 1, 0);
  assert(mask.get(0)); // anchor index 0 claimed
  assert(!mask.get(1));
  assert(!mask.get(2));
});

Deno.test('computeClaimMask: with subtree claims, own anchor claim skips claimed', () => {
  const { module } = setupModule();
  const anchorOutputCount = 5;
  const mergedSubtreeMask = BitVector.fromIndices(anchorOutputCount, [1, 3]);
  const mask = module.computeClaimMask(anchorOutputCount, mergedSubtreeMask, [5], 2, 3);
  assert(mask.get(0));
  assert(mask.get(1));
  assert(mask.get(3));
  assert(!mask.get(2));
  assert(!mask.get(4));
});

Deno.test('computeClaimMask: claim on subtree output does not affect anchor mask', () => {
  const { module } = setupModule();
  const anchorOutputCount = 5;
  const mergedSubtreeMask = BitVector.empty(anchorOutputCount);
  const mask = module.computeClaimMask(anchorOutputCount, mergedSubtreeMask, [2], 1, 3);
  assertEquals(mask.popcount(), 0);
});

Deno.test('computeClaimMask: multiple anchor claims map correctly', () => {
  const { module } = setupModule();
  const anchorOutputCount = 6;
  const mergedSubtreeMask = BitVector.fromIndices(anchorOutputCount, [2]);
  const mask = module.computeClaimMask(anchorOutputCount, mergedSubtreeMask, [3, 5], 1, 2);
  assert(mask.get(0));
  assert(mask.get(2));
  assert(mask.get(3));
  assert(!mask.get(1));
  assert(!mask.get(4));
  assert(!mask.get(5));
});

// -- buildBlock tests --------------------------------------------

Deno.test('buildBlock: simple leaf block', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(80), makeOutput(20)],
    claims: [
      { index: 2, value: 100 }, // non-self: targets anchor output
    ],
    declaredWeight: 10,
    aggregates: [],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  // Leaf block: no aggregation contract output added
  assertEquals(blueprint.outputs.length, 2);
  assertEquals(blueprint.declaredWeight, 10);
  assertEquals(blueprint.aggregates, []);
  assertEquals(blueprint.claims, [2]);
});

Deno.test('buildBlock: leaf block with self-claim', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 3, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(50), makeOutput(100)],
    claims: [
      { index: 0, value: 50 }, // self-claim
      { index: 2, value: 100 }, // anchor claim
    ],
    declaredWeight: 5,
    aggregates: [],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  assertEquals(blueprint.outputs.length, 2);
  assertEquals(blueprint.claims, [0, 2]);
});

Deno.test('buildBlock: aggregation block with subtrees', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  const subtree1 = h('subtree1');
  const subtree2 = h('subtree2');

  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 10, weightVector: [] });
  provider.add({
    hash: subtree1,
    anchor: genesis,
    outputCount: 4,
    weightVector: [20],
  });
  provider.add({
    hash: subtree2,
    anchor: genesis,
    outputCount: 3,
    weightVector: [15],
  });

  // Set up anchor depths: subtrees anchor to genesis, which is our anchor too → depth 0
  provider.setAnchorDepth(genesis, genesis, 0);

  // Subtree1 claims anchor outputs [2, 5], subtree2 claims [7]
  provider.setRebasedClaimMask(subtree1, genesis, BitVector.fromIndices(10, [2, 5]));
  provider.setRebasedClaimMask(subtree2, genesis, BitVector.fromIndices(10, [7]));

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(10)], // aggregation incentive output
    claims: [
      { index: 1, value: 5 }, // claim subtree1's output (inside subtree range)
      { index: 5, value: 5 }, // claim subtree2's output (inside subtree range)
    ],
    declaredWeight: 2,
    aggregates: [subtree1, subtree2],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  assertEquals(blueprint.aggregates.length, 2);
  // Outputs: 1 user output + 1 aggregation contract output
  assertEquals(blueprint.outputs.length, 2);

  // Check aggregation data in contract output
  const aggData = getAggData(blueprint.outputs);
  assert(aggData !== null);
  if (aggData) {
    assertEquals(aggData.aggregateOutputCounts, [4, 3]);
    // chainWeights: full weight [37] minus declaredWeight [2] = [35]
    assertEquals(aggData.chainWeights, [35]);
    // Claim mask: subtree claims on anchor [2, 5, 7]
    assert(aggData.claimMask.get(2));
    assert(aggData.claimMask.get(5));
    assert(aggData.claimMask.get(7));
    assertEquals(aggData.claimMask.popcount(), 3);
  }
});

Deno.test('buildBlock: aggregation with subtrees at different depths', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  const blockA = h('A');
  const subtree1 = h('subtree1');
  const subtree2 = h('subtree2');

  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });
  provider.add({ hash: blockA, anchor: genesis, outputCount: 8, weightVector: [10] });
  provider.add({
    hash: subtree1,
    anchor: genesis,
    outputCount: 3,
    weightVector: [10, 5],
  });
  provider.add({
    hash: subtree2,
    anchor: blockA,
    outputCount: 2,
    weightVector: [20],
  });

  provider.setAnchorDepth(blockA, genesis, 1);
  provider.setAnchorDepth(blockA, blockA, 0);

  provider.setRebasedClaimMask(subtree1, blockA, BitVector.fromIndices(8, [1]));
  provider.setRebasedClaimMask(subtree2, blockA, BitVector.fromIndices(8, [3]));

  const spec: BlockSpec = {
    anchor: blockA,
    outputs: [makeOutput(10)],
    claims: [
      { index: 1, value: 5 }, // subtree output
      { index: 4, value: 5 }, // subtree output
    ],
    declaredWeight: 3,
    aggregates: [subtree1, subtree2],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  const aggData = getAggData(blueprint.outputs);
  assert(aggData !== null);
  if (aggData) {
    // chainWeights: full weight is [23, 10, 5], minus declaredWeight(3) at [0] = [20, 10, 5]
    assertEquals(aggData.chainWeights, [20, 10, 5]);
    assertEquals(aggData.aggregateOutputCounts, [3, 2]);
  }
});

Deno.test('buildBlock: fails on missing anchor', () => {
  const { module } = setupModule();

  const spec: BlockSpec = {
    anchor: h('nonexistent'),
    outputs: [],
    claims: [],
    declaredWeight: 0,
    aggregates: [],
    refs: [],
  };

  assertThrows(() => module.buildBlock(spec), Error, 'anchor');
});

Deno.test('buildBlock: fails on missing aggregated block', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [],
    claims: [],
    declaredWeight: 0,
    aggregates: [h('missing')],
    refs: [],
  };

  assertThrows(() => module.buildBlock(spec), Error, 'aggregated block not found');
});

Deno.test('buildBlock: fails on throughput imbalance', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(50)],
    claims: [
      { index: 1, value: 100 },
    ],
    declaredWeight: 0,
    aggregates: [],
    refs: [],
  };

  assertThrows(() => module.buildBlock(spec), Error, 'throughput imbalance');
});

Deno.test('buildBlock: fails on inter-subtree conflict', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  const subtree1 = h('subtree1');
  const subtree2 = h('subtree2');

  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });
  provider.add({ hash: subtree1, anchor: genesis, outputCount: 2, weightVector: [10] });
  provider.add({ hash: subtree2, anchor: genesis, outputCount: 2, weightVector: [10] });

  provider.setAnchorDepth(genesis, genesis, 0);

  // Both subtrees claim anchor output 2 — conflict!
  provider.setRebasedClaimMask(subtree1, genesis, BitVector.fromIndices(5, [2]));
  provider.setRebasedClaimMask(subtree2, genesis, BitVector.fromIndices(5, [2]));

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [],
    claims: [],
    declaredWeight: 0,
    aggregates: [subtree1, subtree2],
    refs: [],
  };

  assertThrows(() => module.buildBlock(spec), Error, 'inter-subtree conflict');
});

Deno.test('buildBlock: fails on claim index out of range', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 3, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(100)],
    claims: [
      { index: 99, value: 100 }, // way out of range
    ],
    declaredWeight: 0,
    aggregates: [],
    refs: [],
  };

  assertThrows(() => module.buildBlock(spec), Error, 'out of range');
});

Deno.test('buildBlock: block with only self-claims (no anchor claims)', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 3, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(50), makeOutput(25)],
    claims: [
      { index: 0, value: 50 }, // self-claim
      { index: 1, value: 25 }, // self-claim
    ],
    declaredWeight: 7,
    aggregates: [],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  // Leaf block: no aggregation output
  assertEquals(blueprint.outputs.length, 2);
});

Deno.test('buildBlock: block with no outputs and no claims', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [],
    claims: [],
    declaredWeight: 10,
    aggregates: [],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  assertEquals(blueprint.outputs.length, 0);
});

Deno.test('buildBlock: aggregation block with own anchor claim', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  const subtree = h('subtree');

  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 8, weightVector: [] });
  provider.add({ hash: subtree, anchor: genesis, outputCount: 3, weightVector: [15] });

  provider.setAnchorDepth(genesis, genesis, 0);
  provider.setRebasedClaimMask(subtree, genesis, BitVector.fromIndices(8, [1, 4]));

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [makeOutput(20)],
    claims: [
      { index: 5, value: 20 }, // anchor claim → maps to anchor[2]
    ],
    declaredWeight: 5,
    aggregates: [subtree],
    refs: [],
  };

  const blueprint = module.buildBlock(spec);
  const aggData = getAggData(blueprint.outputs);
  assert(aggData !== null);
  if (aggData) {
    // claimMask should have subtree's [1, 4] plus our claim on anchor[2]
    assert(aggData.claimMask.get(1));
    assert(aggData.claimMask.get(2)); // our claim
    assert(aggData.claimMask.get(4));
    assertEquals(aggData.claimMask.popcount(), 3);
  }
});

Deno.test('buildBlock: fails when subtree rebase returns null', () => {
  const { provider, module } = setupModule();
  const genesis = h('genesis');
  const subtree = h('subtree');

  provider.add({ hash: genesis, anchor: ZERO_HASH, outputCount: 5, weightVector: [] });
  provider.add({ hash: subtree, anchor: genesis, outputCount: 2, weightVector: [10] });

  provider.setAnchorDepth(genesis, genesis, 0);
  provider.setRebasedClaimMask(subtree, genesis, null);

  const spec: BlockSpec = {
    anchor: genesis,
    outputs: [],
    claims: [],
    declaredWeight: 0,
    aggregates: [subtree],
    refs: [],
  };

  assertThrows(() => module.buildBlock(spec), Error, 'rebase');
});
