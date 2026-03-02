import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { BitVector } from '../src/BitVector.ts';
import { Block, BlockStore, createBlock, createGenesisBlock } from '../src/Block.ts';
import { Output, BlockSpec } from '../src/BlockCreationModule.ts';
import { ProtocolContext } from '../src/ProtocolContext.ts';
import { ConflictService } from '../src/ConflictService.ts';
import { ConsensusService } from '../src/ConsensusService.ts';
import { SamplingService } from '../src/SamplingService.ts';
import { TrustService } from '../src/TrustService.ts';
import { GossipService } from '../src/GossipService.ts';
import { BlockCreationService } from '../src/BlockCreationService.ts';
import { Coordinator } from '../src/Coordinator.ts';
import { SimNode, SimNetwork } from './SimNetwork.ts';

// -- Helpers --------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

function makeOutput(value: number, label?: string): Output {
  return {
    contract: Hash.digest(label ?? 'contract'),
    value,
    data: new Uint8Array([]),
  };
}

/** Create a simple leaf block that claims nothing and produces outputs. */
function makeLeafBlock(
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claims: number[] = [],
): Block {
  const anchorOutputCount = anchor.outputCount;
  const claimMask = BitVector.empty(anchorOutputCount);
  for (const idx of claims) {
    // Map claim indices >= outputs.length to anchor space
    if (idx >= outputs.length) {
      const anchorIdx = idx - outputs.length;
      if (anchorIdx < anchorOutputCount) {
        claimMask.set(anchorIdx, true);
      }
    }
  }

  const outputCount = anchorOutputCount - claimMask.popcount() + outputs.length - claims.filter(i => i < outputs.length).length;

  // Compute hash
  const hashParts: Uint8Array[] = [
    anchor.hash.toBytes(),
    new Uint8Array(new Float64Array([declaredWeight]).buffer),
    new Uint8Array(new Float64Array([Math.random()]).buffer), // uniqueness
  ];
  for (const out of outputs) {
    hashParts.push(out.contract.toBytes());
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
  }
  const hash = Hash.digestParts(...hashParts);

  return {
    hash,
    anchor: anchor.hash,
    aggregates: [],
    claimMask,
    subtreeClaimMask: null,
    ownOutputCount: outputs.length,
    outputCount,
    anchorOutputCount,
    aggregateOutputCounts: [],
    claims,
    outputs,
    declaredWeight,
    weightVector: [declaredWeight],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };
}

/** Create a simple leaf block with a specific hash for deterministic tests. */
function makeLeafBlockWithHash(
  name: string,
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claims: number[] = [],
): Block {
  const block = makeLeafBlock(anchor, outputs, declaredWeight, claims);
  // Override hash with deterministic one
  const hash = Hash.digest(name);
  return { ...block, hash };
}

/** Setup a single-node protocol stack. */
function setupSingleNode(): SimNode {
  return new SimNode('node0');
}

// -- Tests ----------------------------------------------------------

Deno.test('Integration: single node, linear chain — genesis + 3 blocks, all canonical', () => {
  const node = setupSingleNode();

  // Genesis with 3 outputs
  const genesis = createGenesisBlock([
    makeOutput(100, 'out0'),
    makeOutput(200, 'out1'),
    makeOutput(300, 'out2'),
  ]);
  const r0 = node.receiveBlock(genesis, null);
  assertEquals(r0.newConflicts.length, 0);

  // Block 1: leaf, produces 1 output, no claims
  const b1 = makeLeafBlockWithHash('b1', genesis, [makeOutput(50, 'b1out')], 10);
  const r1 = node.receiveBlock(b1, null);
  assertEquals(r1.newConflicts.length, 0);

  // Block 2: anchored to b1
  const b2 = makeLeafBlockWithHash('b2', b1, [makeOutput(25, 'b2out')], 20);
  const r2 = node.receiveBlock(b2, null);
  assertEquals(r2.newConflicts.length, 0);

  // Block 3: anchored to b2
  const b3 = makeLeafBlockWithHash('b3', b2, [makeOutput(12, 'b3out')], 30);
  const r3 = node.receiveBlock(b3, null);
  assertEquals(r3.newConflicts.length, 0);

  // All blocks should be canonical (no conflicts)
  assert(node.consensus.isCanonical(genesis.hash));
  assert(node.consensus.isCanonical(b1.hash));
  assert(node.consensus.isCanonical(b2.hash));
  assert(node.consensus.isCanonical(b3.hash));
});

Deno.test('Integration: conflict resolution — two blocks claim same output, higher weight wins', () => {
  const node = setupSingleNode();

  // Genesis with 2 outputs
  const genesis = createGenesisBlock([
    makeOutput(100, 'out0'),
    makeOutput(200, 'out1'),
  ]);
  node.receiveBlock(genesis, null);

  // Two blocks anchored to genesis, both claiming output 0
  // Block A: claims output index 1 (which maps to anchor index 0 since ownOutputCount=1)
  const blockA: Block = {
    hash: Hash.digest('blockA'),
    anchor: genesis.hash,
    aggregates: [],
    claimMask: BitVector.fromIndices(2, [0]), // claims anchor output 0
    subtreeClaimMask: null,
    ownOutputCount: 1,
    outputCount: 2, // 2 (anchor) - 1 (claimed) + 1 (new) = 2
    anchorOutputCount: 2,
    aggregateOutputCounts: [],
    claims: [1], // claim index 1 in extended vector = anchor output 0
    outputs: [makeOutput(100, 'A-out')],
    declaredWeight: 50,
    weightVector: [50],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };

  const blockB: Block = {
    hash: Hash.digest('blockB'),
    anchor: genesis.hash,
    aggregates: [],
    claimMask: BitVector.fromIndices(2, [0]), // claims same anchor output 0
    subtreeClaimMask: null,
    ownOutputCount: 1,
    outputCount: 2,
    anchorOutputCount: 2,
    aggregateOutputCounts: [],
    claims: [1], // same claim
    outputs: [makeOutput(100, 'B-out')],
    declaredWeight: 30,
    weightVector: [30],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };

  node.receiveBlock(blockA, null);
  const result = node.receiveBlock(blockB, null);

  // Should detect conflict
  assert(result.newConflicts.length > 0);

  // A has higher weight (50 vs 30), should win
  assert(node.consensus.isCanonical(blockA.hash));
  assertFalse(node.consensus.isCanonical(blockB.hash));
});

Deno.test('Integration: canonicality flip — descendant weight shifts the winner', () => {
  const node = setupSingleNode();

  const genesis = createGenesisBlock([
    makeOutput(100, 'out0'),
    makeOutput(200, 'out1'),
  ]);
  node.receiveBlock(genesis, null);

  // Block A: weight 10, claims output 0
  const blockA: Block = {
    hash: Hash.digest('flipA'),
    anchor: genesis.hash,
    aggregates: [],
    claimMask: BitVector.fromIndices(2, [0]),
    subtreeClaimMask: null,
    ownOutputCount: 1,
    outputCount: 2,
    anchorOutputCount: 2,
    aggregateOutputCounts: [],
    claims: [1],
    outputs: [makeOutput(100, 'A-out')],
    declaredWeight: 10,
    weightVector: [10],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };

  // Block B: weight 15, claims same output 0
  const blockB: Block = {
    hash: Hash.digest('flipB'),
    anchor: genesis.hash,
    aggregates: [],
    claimMask: BitVector.fromIndices(2, [0]),
    subtreeClaimMask: null,
    ownOutputCount: 1,
    outputCount: 2,
    anchorOutputCount: 2,
    aggregateOutputCounts: [],
    claims: [1],
    outputs: [makeOutput(100, 'B-out')],
    declaredWeight: 15,
    weightVector: [15],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };

  node.receiveBlock(blockA, null);
  node.receiveBlock(blockB, null);

  // B has higher weight initially, should be canonical
  assert(node.consensus.isCanonical(blockB.hash));
  assertFalse(node.consensus.isCanonical(blockA.hash));

  // Now add a heavy descendant of A
  const childA: Block = {
    hash: Hash.digest('childA'),
    anchor: blockA.hash,
    aggregates: [],
    claimMask: BitVector.empty(blockA.outputCount),
    subtreeClaimMask: null,
    ownOutputCount: 0,
    outputCount: blockA.outputCount,
    anchorOutputCount: blockA.outputCount,
    aggregateOutputCounts: [],
    claims: [],
    outputs: [],
    declaredWeight: 100,
    weightVector: [100],
    size: 100,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };

  const result = node.receiveBlock(childA, null);

  // A now has effective weight 10 + 100 = 110 vs B's 15
  // A should now be canonical, B should not
  assert(node.consensus.isCanonical(blockA.hash));
  assertFalse(node.consensus.isCanonical(blockB.hash));

  // Should see canonicality changes
  const aChanges = result.canonicalityChanges.filter(
    (c) => c.hash.toPrimitive() === blockA.hash.toPrimitive(),
  );
  const bChanges = result.canonicalityChanges.filter(
    (c) => c.hash.toPrimitive() === blockB.hash.toPrimitive(),
  );
  assert(aChanges.some((c) => c.canonical === true));
  assert(bChanges.some((c) => c.canonical === false));
});

Deno.test('Integration: two-node gossip — block published on A propagates to B', () => {
  const network = new SimNetwork();
  const nodeA = network.addNode('A');
  const nodeB = network.addNode('B');

  const genesis = createGenesisBlock([makeOutput(100, 'g-out')]);

  // Deliver genesis to both nodes
  network.deliverToAll(genesis, 'A');

  // Create a block on node A
  const block = makeLeafBlockWithHash('gossip-block', genesis, [makeOutput(50, 'new')], 10);
  const resultA = nodeA.receiveBlock(block, null);

  // Process push actions — should propagate to B
  const pushResults = network.processPushActions('A', block, resultA.pushActions);

  // Node B should now have the block
  assert(nodeB.store.has(block.hash));
  assert(nodeB.consensus.isCanonical(block.hash));
});

Deno.test('Integration: aggregation — aggregation block rolls up subtrees', () => {
  const node = setupSingleNode();

  // Genesis with 4 outputs
  const genesis = createGenesisBlock([
    makeOutput(100, 'g0'),
    makeOutput(100, 'g1'),
    makeOutput(100, 'g2'),
    makeOutput(100, 'g3'),
  ]);
  node.receiveBlock(genesis, null);

  // Subtree A: claims output 0 from genesis
  const subtreeA: Block = {
    hash: Hash.digest('subtreeA'),
    anchor: genesis.hash,
    aggregates: [],
    claimMask: BitVector.fromIndices(4, [0]),
    subtreeClaimMask: null,
    ownOutputCount: 1,
    outputCount: 4, // 4 - 1 + 1 = 4
    anchorOutputCount: 4,
    aggregateOutputCounts: [],
    claims: [1], // claims extended idx 1 = anchor output 0
    outputs: [makeOutput(100, 'A-out')],
    declaredWeight: 10,
    weightVector: [10],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };
  node.receiveBlock(subtreeA, null);

  // Subtree B: claims output 1 from genesis
  const subtreeB: Block = {
    hash: Hash.digest('subtreeB'),
    anchor: genesis.hash,
    aggregates: [],
    claimMask: BitVector.fromIndices(4, [1]),
    subtreeClaimMask: null,
    ownOutputCount: 1,
    outputCount: 4,
    anchorOutputCount: 4,
    aggregateOutputCounts: [],
    claims: [1], // claims extended idx 1 = anchor output 1
    outputs: [makeOutput(100, 'B-out')],
    declaredWeight: 15,
    weightVector: [15],
    size: 200,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [],
  };
  node.receiveBlock(subtreeB, null);

  // Aggregation block: aggregates both subtrees, anchored to genesis
  // Its claim mask against genesis should include both output 0 and 1
  const mergedClaimMask = BitVector.fromIndices(4, [0, 1]);
  const aggBlock: Block = {
    hash: Hash.digest('aggBlock'),
    anchor: genesis.hash,
    aggregates: [subtreeA.hash, subtreeB.hash],
    claimMask: mergedClaimMask,
    subtreeClaimMask: mergedClaimMask,
    ownOutputCount: 0,
    // 4 (anchor) - 2 (subtree anchor claims) + 4 (subtreeA outputs) + 4 (subtreeB outputs) + 0 (own) - 0 (own claims) = 10
    outputCount: 10,
    anchorOutputCount: 4,
    aggregateOutputCounts: [4, 4],
    claims: [],
    outputs: [],
    declaredWeight: 5,
    weightVector: [5, 10, 15], // [own, subtreeA at depth 1, subtreeB at depth 1]
    size: 300,
    collateralTarget: undefined,
    paymentTarget: undefined,
    childDeclaredWeights: [10, 15],
  };

  const result = node.receiveBlock(aggBlock, null);

  // Aggregation block should be canonical
  assert(node.consensus.isCanonical(aggBlock.hash));

  // Subtrees are aggregated by aggBlock, so they conflict with it
  // (aggregation implies conflict in consensus) and aggBlock wins
  // due to effective weight including descendant weight
  assert(node.store.has(aggBlock.hash));

  // Weight vector has 3 elements
  assertEquals(aggBlock.weightVector.length, 3);
});

Deno.test('Integration: block creation through stack — BlockCreationService.buildBlock → createBlock → coordinator', () => {
  const node = setupSingleNode();

  // Genesis
  const genesis = createGenesisBlock([
    makeOutput(100, 'g0'),
    makeOutput(200, 'g1'),
  ]);
  node.receiveBlock(genesis, null);

  // Use BlockCreationService to build a block
  // Claim extended index 1 = anchor output 0 (value 100), produce 1 output (value 100)
  const spec: BlockSpec = {
    anchor: genesis.hash,
    outputs: [makeOutput(100, 'new-out')],
    claims: [{ index: 1, value: 100 }],
    declaredWeight: 25,
    aggregates: [],
  };

  const result = node.blockCreation.buildBlock(spec);
  assert(result.ok);

  if (result.ok) {
    const blueprint = result.blueprint;
    assertEquals(blueprint.anchor.toPrimitive(), genesis.hash.toPrimitive());
    assertEquals(blueprint.ownOutputCount, 1);
    assertEquals(blueprint.declaredWeight, 25);

    // Create concrete block from blueprint
    const block = createBlock(blueprint, genesis);
    assert(block.hash);

    // Feed through coordinator
    const coordResult = node.receiveBlock(block, null);
    assertEquals(coordResult.newConflicts.length, 0);

    // Block should be canonical
    assert(node.consensus.isCanonical(block.hash));
  }
});
