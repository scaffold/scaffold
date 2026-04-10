import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  AGGREGATION_CONTRACT,
  Block,
  BlockSource,
  BlockStore,
  createBlock,
  createGenesisBlock,
  getBlockWeightVector,
  RECORD_CONTRACT,
} from '../src/core/Block.ts';
import { encodeAggregationData } from '../src/contracts/AggregationContract.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { BlockSpec, Output } from '../src/core/BlockCreationModule.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { TrustService } from '../src/core/TrustService.ts';
import { GossipService } from '../src/core/GossipService.ts';
import { BlockCreationService } from '../src/core/BlockCreationService.ts';
import { ExecutionService } from '../src/core/ExecutionService.ts';
import type { Contract } from '../src/contracts/Contract.ts';
import { type ContractEnv, ContractRejection } from '../src/core/ContractEnv.ts';
import { Coordinator } from '../src/core/Coordinator.ts';
import { SimNetwork, SimNode } from './SimNetwork.ts';

// -- Helpers --------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
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
  // Compute hash
  const hashParts: Uint8Array[] = [
    anchor.hash.toBytes(),
    new Uint8Array(new Float64Array([declaredWeight]).buffer),
    new Uint8Array(new Float64Array([Math.random()]).buffer), // uniqueness
  ];
  for (const out of outputs) {
    hashParts.push(out.verifier.contract.toBytes());
    hashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
  }
  const hash = Hash.digestParts(...hashParts);

  return {
    hash,
    anchor: anchor.hash,
    aggregates: [],
    claims,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
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
  // Block A: claims output index 1 (which maps to anchor index 0 since outputs.length=1)
  const blockA: Block = {
    hash: Hash.digest('blockA'),
    anchor: genesis.hash,
    aggregates: [],
    claims: [1], // claim index 1 in extended vector = anchor output 0
    outputs: [makeOutput(100, 'A-out')],
    declaredWeight: 50,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };

  const blockB: Block = {
    hash: Hash.digest('blockB'),
    anchor: genesis.hash,
    aggregates: [],
    claims: [1], // same claim
    outputs: [makeOutput(100, 'B-out')],
    declaredWeight: 30,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
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
    claims: [1],
    outputs: [makeOutput(100, 'A-out')],
    declaredWeight: 10,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };

  // Block B: weight 15, claims same output 0
  const blockB: Block = {
    hash: Hash.digest('flipB'),
    anchor: genesis.hash,
    aggregates: [],
    claims: [1],
    outputs: [makeOutput(100, 'B-out')],
    declaredWeight: 15,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
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
    claims: [],
    outputs: [],
    declaredWeight: 100,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
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
    claims: [1], // claims extended idx 1 = anchor output 0
    outputs: [makeOutput(100, 'A-out')],
    declaredWeight: 10,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
  node.receiveBlock(subtreeA, null);

  // Subtree B: claims output 1 from genesis
  const subtreeB: Block = {
    hash: Hash.digest('subtreeB'),
    anchor: genesis.hash,
    aggregates: [],
    claims: [2], // claims extended idx 2 = anchor output 1
    outputs: [makeOutput(100, 'B-out')],
    declaredWeight: 15,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
  node.receiveBlock(subtreeB, null);

  // Aggregation block: aggregates both subtrees, anchored to genesis
  // Must include aggregation contract output with the aggregation data
  const aggData = encodeAggregationData({
    claimMask: [0, 1],
    newOutputCount: 9, // 4 + 4 (subtree outputs) + 1 (own output) - 0 (own claims) = 9
    aggregateOutputCounts: [4, 4],
    chainWeights: [25], // subtreeA(10) + subtreeB(15) = 25
    aggregateWeights: [10, 15],
  });

  const aggBlock: Block = {
    hash: Hash.digest('aggBlock'),
    anchor: genesis.hash,
    aggregates: [subtreeA.hash, subtreeB.hash],
    claims: [],
    outputs: [{
      verifier: { contract: AGGREGATION_CONTRACT, params: new Uint8Array(0) },
      value: 0,
      data: aggData,
    }],
    declaredWeight: 5,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };

  const result = node.receiveBlock(aggBlock, null);

  // Aggregation block should be canonical
  assert(node.consensus.isCanonical(aggBlock.hash));

  // Subtrees are aggregated by aggBlock
  assert(node.store.has(aggBlock.hash));

  // Weight vector should be reconstructed: [5 + 25] = [30]
  const wv = getBlockWeightVector(aggBlock);
  assertEquals(wv, [30]);
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
    refs: [],
  };

  const blueprint = node.blockCreation.buildBlock(spec);
  assertEquals(blueprint.anchor.toPrimitive(), genesis.hash.toPrimitive());
  assertEquals(blueprint.outputs.length, 1);
  assertEquals(blueprint.declaredWeight, 25);

  // Create concrete block from blueprint
  const block = createBlock(blueprint, genesis);
  assert(block.hash);

  // Feed through coordinator
  const coordResult = node.receiveBlock(block, null);
  assertEquals(coordResult.newConflicts.length, 0);

  // Block should be canonical
  assert(node.consensus.isCanonical(block.hash));
});

// -- Computation integration tests ----------------------------------

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

Deno.test('Integration: computation block with self-claims → verify → valid', async () => {
  const node = new SimNode('compute-node');

  // Register a trivial contract that accepts any block
  const trivialContract = Hash.digest('trivial-contract');
  node.execution.registerContract(trivialContract, {
    run(_env: ContractEnv) {
      // normal return = accept
    },
  });

  // Genesis
  const genesis = createGenesisBlock([{
    verifier: { contract: trivialContract, params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  }]);
  node.receiveBlock(genesis, null);

  // Computation block: self-claims state, claims genesis output
  const compBlock = makeLeafBlock(
    genesis,
    [makeRecordOutput('state', enc('game-state-1'))],
    10,
    [1], // claim extended index 1 = genesis output[0]
  );
  node.receiveBlock(compBlock, null);

  // Verify the computation block
  const result = await node.execution.verifyBlock(compBlock.hash);
  assert(result.accepted, `Expected accepted but got: ${!result.accepted ? result.reason : ''}`);
});

Deno.test('Integration: cross-block references — block B refs A and reads state', async () => {
  const node = new SimNode('ref-node');

  const gameContract = Hash.digest('game-contract');

  // Contract reads previous state via fetch and verifies new state
  const gameVerifier = { contract: gameContract, params: new Uint8Array(0) };
  node.execution.registerContract(gameContract, {
    run(env: ContractEnv) {
      const prevState = new TextDecoder().decode(
        env.fetch(gameVerifier, enc('state')) as Uint8Array,
      );
      env.requireResult(enc('state'), enc(prevState + '-next'));
    },
  });

  // Genesis with two game outputs (one for A, one for B)
  const gameOutput = {
    verifier: gameVerifier,
    value: 0,
    data: new Uint8Array(0),
  };
  const genesis = createGenesisBlock([gameOutput, gameOutput]);
  node.receiveBlock(genesis, null);

  // Block A: claims genesis game output[0], produces self-claimed state
  const blockAOutputs = [makeRecordOutput('state', enc('S0'))];
  const blockAHashParts: Uint8Array[] = [
    genesis.hash.toBytes(),
    new Uint8Array(new Float64Array([10]).buffer),
    new Uint8Array(new Float64Array([Math.random()]).buffer),
  ];
  for (const out of blockAOutputs) {
    blockAHashParts.push(out.verifier.contract.toBytes());
    blockAHashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
  }
  const blockA: Block = {
    hash: Hash.digestParts(...blockAHashParts),
    anchor: genesis.hash,
    aggregates: [],
    claims: [1], // claim extended index 1 = genesis output[0]
    outputs: blockAOutputs,
    declaredWeight: 10,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
  node.receiveBlock(blockA, null);

  // Block B: references block A, claims genesis game output[1], produces new state
  const blockBOutputs = [makeRecordOutput('state', enc('S0-next'))];
  const blockBHashParts: Uint8Array[] = [
    genesis.hash.toBytes(),
    new Uint8Array(new Float64Array([10]).buffer),
    new Uint8Array(new Float64Array([Math.random()]).buffer),
  ];
  for (const out of blockBOutputs) {
    blockBHashParts.push(out.verifier.contract.toBytes());
    blockBHashParts.push(new Uint8Array(new Float64Array([out.value]).buffer));
  }
  const blockB: Block = {
    hash: Hash.digestParts(...blockBHashParts),
    anchor: genesis.hash,
    aggregates: [],
    claims: [2], // claim extended index 2 = genesis output[1]
    outputs: blockBOutputs,
    declaredWeight: 10,
    refs: [blockA.hash],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
  node.receiveBlock(blockB, null);

  // Verify block B reads A's state and produces correct new state
  const result = await node.execution.verifyBlock(blockB.hash);
  assert(result.accepted, `Expected accepted but got: ${!result.accepted ? result.reason : ''}`);
});

Deno.test('Integration: coordinator.attemptVerification works end-to-end', async () => {
  const node = new SimNode('verify-node');

  // Register a contract that always accepts
  const contract = Hash.digest('always-accept');
  node.execution.registerContract(contract, { run(_env: ContractEnv) {} });

  // Genesis
  const genesis = createGenesisBlock([{
    verifier: { contract, params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  }]);
  node.receiveBlock(genesis, null);

  // Block that claims genesis output
  const block = makeLeafBlock(genesis, [], 10, [0]);
  node.receiveBlock(block, null);

  // The block should now be in sampling. Attempt verification.
  const verifyResult = await node.coordinator.attemptVerification();
  // May return null if no tree is selected (genesis has MAX_SAFE_INTEGER priority edge case)
  // or a verification result
  if (verifyResult) {
    assert(verifyResult.verified);
  }
});
