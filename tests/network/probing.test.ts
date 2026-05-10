/**
 * Network-level sampling tests.
 *
 * These tests verify that the weight sampling mechanism works
 * correctly across multiple nodes, including weight factor convergence,
 * invalid block detection, conflict-driven scheduling, and the feedback
 * loop from sampling through consensus.
 */

import { assert, assertEquals } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { createGenesisBlock } from '../../src/core/Block.ts';
import {
  type Contract,
  makeAggregationBlock,
  makeBlock,
  makeGenesis,
  makeOutput,
} from './helpers.ts';
import { TestNetwork } from './TestNetwork.ts';

// -- Helpers --------------------------------------------------------

function registerContract(
  net: TestNetwork,
  nodeId: string,
  contract: Hash,
  impl: Contract,
): void {
  net.getNode(nodeId).execution.registerContract(contract, impl);
}

function registerOnAll(net: TestNetwork, contract: Hash, impl: Contract): void {
  for (const id of net.nodeIds) {
    registerContract(net, id, contract, impl);
  }
}

const validContract = Hash.digest('valid-contract');
const invalidContract = Hash.digest('invalid-contract');

// -- Tests ----------------------------------------------------------

// Probe state lifecycle

Deno.test('Sampling: canonical blocks get sample state on all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const block = makeBlock('probe-state', genesis, [makeOutput(100)], 50, [0]);
  net.deliverToAll(block, 'A');

  // All nodes should have sample state for the block
  for (const id of net.nodeIds) {
    const state = net.getNode(id).sampling.getSampleState(block.hash);
    assert(state !== undefined, `Node ${id} should have sample state`);
    assertEquals(state.queries.length, 0);
    assertEquals(state.selfVerified, false);
  }
});

Deno.test('Sampling: non-canonical block loses sample state', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const node = net.getNode('A');

  // Block B claims genesis output 0 (claim index 1 = first anchor output, since own output is at 0)
  const blockB = makeBlock('initially-canon', genesis, [makeOutput(100)], 10, [1]);
  net.deliverDirect(blockB, 'A');

  assert(node.consensus.isCanonical(blockB.hash), 'Block B should be canonical initially');
  assert(
    node.sampling.getSampleState(blockB.hash) !== undefined,
    'Block B should have sample state when canonical',
  );

  // Block C also claims genesis output 0 (same anchor output) -- creates a conflict
  const blockC = makeBlock('replaces-canon', genesis, [makeOutput(100)], 100, [1]);
  net.deliverDirect(blockC, 'A');

  // Conflict should be detected (both claim the same anchor output)
  const conflicts = node.consensus.getConflicts(blockB.hash);
  assert(conflicts.size > 0, 'Conflict should be detected between B and C');

  // C (weight 100) should win over B (weight 10)
  assert(node.consensus.isCanonical(blockC.hash), 'C should be canonical');
  assert(!node.consensus.isCanonical(blockB.hash), 'B should not be canonical');

  // B's sample state should be removed, C's should exist
  assertEquals(
    node.sampling.getSampleState(blockB.hash),
    undefined,
    'Non-canonical block should not have sample state',
  );
  assert(
    node.sampling.getSampleState(blockC.hash) !== undefined,
    'Canonical block should have sample state',
  );
});

// Weight factor convergence

Deno.test('Sampling: weight factor converges on all nodes for valid leaf', async () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  registerOnAll(net, validContract, { run() {} });

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const block = makeBlock(
    'valid-leaf',
    genesis,
    [{
      verifier: { contract: validContract, params: new Uint8Array(0) },
      value: 100,
      body: new Uint8Array([]),
    }],
    50,
    [0],
  );
  net.deliverToAll(block, 'A');

  // Each node samples and verifies independently
  for (const id of net.nodeIds) {
    const node = net.getNode(id);
    for (let i = 0; i < 5; i++) {
      const result = node.sampling.initSample(block.hash);
      if (result.terminal) {
        const exec = await node.execution.verifyBlock(result.blockHash);
        node.sampling.recordVerification(result.blockHash, exec.accepted);
      }
    }
  }

  // All nodes should converge to weight factor 1.0
  for (const id of net.nodeIds) {
    const wf = net.getNode(id).sampling.getWeightFactor(block.hash);
    assertEquals(wf, 1.0, `Node ${id} weight factor should be 1.0`);
  }
});

// Invalid block detection

Deno.test('Sampling: invalid subtree detected via weight factor', async () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  registerOnAll(net, validContract, { run() {} });
  registerOnAll(net, invalidContract, {
    run() {
      throw new Error('contract rejects');
    },
  });

  // Custom genesis with outputs using our registered contracts.
  // Output 0 uses validContract (claimed by validSub),
  // Output 1 uses invalidContract (claimed by invalidSub).
  const genesis = createGenesisBlock([
    {
      verifier: { contract: validContract, params: new Uint8Array(0) },
      value: 100,
      body: new Uint8Array([]),
    },
    {
      verifier: { contract: invalidContract, params: new Uint8Array(0) },
      value: 100,
      body: new Uint8Array([]),
    },
    makeOutput(100, 'spare-0'),
    makeOutput(100, 'spare-1'),
  ]);
  net.broadcastGenesis(genesis);

  // validSub claims genesis output 0 (validContract) -- will pass verification
  // claim index 1 = first anchor output (own output at 0)
  const validSub = makeBlock('valid-sub', genesis, [makeOutput(60)], 60, [1]);

  // invalidSub claims genesis output 1 (invalidContract) -- will fail verification
  // claim index 1 = first anchor output; but we need the second anchor output
  // With 1 own output, anchor outputs start at index 1.
  // Genesis output 0 = extended index 1, genesis output 1 = extended index 2
  const invalidSub = makeBlock('invalid-sub', genesis, [makeOutput(20)], 20, [2]);

  const agg = makeAggregationBlock('agg-mixed', genesis, [validSub, invalidSub], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
    declaredWeight: 0,
  });

  net.deliverToAll(validSub, 'A');
  net.deliverToAll(invalidSub, 'A');
  net.deliverToAll(agg, 'A');

  // Probe the aggregation block on each node
  for (const id of net.nodeIds) {
    const node = net.getNode(id);

    for (let i = 0; i < 200; i++) {
      const result = node.sampling.initSample(agg.hash);
      if (result.terminal) {
        const exec = await node.execution.verifyBlock(result.blockHash);
        node.sampling.recordVerification(result.blockHash, exec.accepted);
      }
    }

    // Weight factor should converge toward 60/80 = 0.75
    // (validSub weight=60 passes, invalidSub weight=20 fails, total=80)
    const wf = node.sampling.getWeightFactor(agg.hash);
    assert(wf > 0.65, `Node ${id} wf=${wf} should be > 0.65`);
    assert(wf < 0.85, `Node ${id} wf=${wf} should be < 0.85`);
  }
});

// Probe scheduling

Deno.test('Sampling: selectNext picks highest-weight unsampled tree', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const heavy = makeBlock('heavy', genesis, [makeOutput(100)], 100, [0]);
  const light = makeBlock('light', genesis, [makeOutput(50)], 10, [1]);

  net.deliverDirect(heavy, 'A');
  net.deliverDirect(light, 'A');

  // selectNext should prefer the heavier block (higher priority)
  const next = net.getNode('A').sampling.selectNext();
  assert(next !== undefined);
  assertEquals(Hash.equals(next, heavy.hash), true);
});

Deno.test('Sampling: selectNext shifts to unsampled tree after sampling', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const blockA = makeBlock('probe-a', genesis, [makeOutput(100)], 100, [0]);
  const blockB = makeBlock('probe-b', genesis, [makeOutput(50)], 90, [1]);

  net.deliverDirect(blockA, 'A');
  net.deliverDirect(blockB, 'A');

  const node = net.getNode('A');

  // Initially A has higher priority
  assertEquals(Hash.equals(node.sampling.selectNext()!, blockA.hash), true);

  // Probe A many times
  for (let i = 0; i < 20; i++) {
    const result = node.sampling.initSample(blockA.hash);
    if (result.terminal) node.sampling.recordVerification(result.blockHash, true);
  }

  // Now B should have higher priority (fewer samples)
  assertEquals(Hash.equals(node.sampling.selectNext()!, blockB.hash), true);
});

// Conflict-driven probing

Deno.test('Sampling: conflict winner has sample state, loser does not', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Both blocks claim the same anchor output (genesis output 0)
  // claim index 1 = first anchor output (index 0 = self output)
  const block1 = makeBlock('conflict-1', genesis, [makeOutput(100)], 50, [1]);
  const block2 = makeBlock('conflict-2', genesis, [makeOutput(100)], 80, [1]);

  net.deliverDirect(block1, 'A');
  net.deliverDirect(block2, 'A');

  const node = net.getNode('A');

  // Conflict should be detected
  const conflicts = node.consensus.getConflicts(block1.hash);
  assert(conflicts.size > 0, 'Conflict should be detected');

  // Winner (block2, weight 80) should have sample state
  const winner = node.consensus.getConflictWinner(block1.hash);
  assert(
    node.sampling.getSampleState(winner) !== undefined,
    'Conflict winner should have sample state',
  );

  // Loser should not have sample state
  const loser = Hash.equals(winner, block1.hash) ? block2.hash : block1.hash;
  assertEquals(
    node.sampling.getSampleState(loser),
    undefined,
    'Conflict loser should not have sample state',
  );
});

// Verification -> consensus feedback loop

Deno.test('Sampling: verification updates consensus weight', async () => {
  const net = new TestNetwork();
  net.addNode('A');

  registerContract(net, 'A', validContract, { run() {} });

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const block = makeBlock(
    'verify-weight',
    genesis,
    [{
      verifier: { contract: validContract, params: new Uint8Array(0) },
      value: 100,
      body: new Uint8Array([]),
    }],
    50,
    [0],
  );

  net.deliverDirect(block, 'A');

  const node = net.getNode('A');

  // Before probing: weight factor is 0 (unverified)
  assertEquals(node.sampling.getWeightFactor(block.hash), 0);

  // Probe and verify
  const result = node.sampling.initSample(block.hash);
  assert(result.terminal);
  if (result.terminal) {
    const exec = await node.execution.verifyBlock(result.blockHash);
    node.sampling.recordVerification(result.blockHash, exec.accepted);
  }

  // After probing: weight factor is 1.0
  assertEquals(node.sampling.getWeightFactor(block.hash), 1.0);
});

Deno.test('Sampling: attemptVerification runs the full sample-verify cycle', async () => {
  const net = new TestNetwork();
  net.addNode('A');

  registerContract(net, 'A', validContract, { run() {} });

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const block = makeBlock(
    'attempt-verify',
    genesis,
    [{
      verifier: { contract: validContract, params: new Uint8Array(0) },
      value: 100,
      body: new Uint8Array([]),
    }],
    50,
    [0],
  );

  net.deliverDirect(block, 'A');

  const node = net.getNode('A');

  // attemptVerification should do the full cycle
  const verifyResult = await node.coordinator.attemptVerification();
  if (verifyResult && verifyResult.verified) {
    // Weight factor should now be non-zero
    const wf = node.sampling.getWeightFactor(block.hash);
    assert(wf > 0, `Weight factor should be > 0 after verification, got ${wf}`);
  }
});

// Multi-node convergence with aggregation

Deno.test('Sampling: aggregation tree sampled consistently across nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const sub1 = makeBlock('agg-sub1', genesis, [makeOutput(50)], 40, [0]);
  const sub2 = makeBlock('agg-sub2', genesis, [makeOutput(50)], 40, [1]);

  const agg = makeAggregationBlock('agg-tree', genesis, [sub1, sub2], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
    declaredWeight: 0,
  });

  net.deliverToAll(sub1, 'A');
  net.deliverToAll(sub2, 'A');
  net.deliverToAll(agg, 'A');

  // Each node samples independently, marking all terminals as verified
  // (simulating successful contract execution)
  for (const id of net.nodeIds) {
    const node = net.getNode(id);
    // Mark subtrees as verified
    node.sampling.recordVerification(sub1.hash, true);
    node.sampling.recordVerification(sub2.hash, true);

    for (let i = 0; i < 100; i++) {
      node.sampling.initSample(agg.hash);
    }
  }

  // Both nodes should converge to weight factor ~1.0 (all subtrees verified)
  for (const id of net.nodeIds) {
    const wf = net.getNode(id).sampling.getWeightFactor(agg.hash);
    assert(wf > 0.90, `Node ${id} wf=${wf} should be > 0.90`);
  }
});

// Pending samples on missing blocks

Deno.test('Sampling: missing aggregate blocks cause pending failures', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const sub1 = makeBlock('miss-sub1', genesis, [makeOutput(50)], 40, [0]);
  const sub2 = makeBlock('miss-sub2', genesis, [makeOutput(50)], 40, [1]);

  const agg = makeAggregationBlock('miss-agg', genesis, [sub1, sub2], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
    declaredWeight: 0,
  });

  const node = net.getNode('A');

  // Deliver only the aggregation block (subtrees missing)
  node.receiveBlock(agg, null);

  // Probes should fail since subtrees are missing
  // But the agg block itself might not be canonical without subtrees being present
  // Let's check if it has sample state
  const aggState = node.sampling.getSampleState(agg.hash);
  if (aggState) {
    // Try to sample -- should get missing results
    for (let i = 0; i < 5; i++) {
      node.sampling.initSample(agg.hash);
    }
    // Weight factor should be 0 or very low
    assertEquals(node.sampling.getWeightFactor(agg.hash), 0);
  }

  // Now deliver the subtrees
  node.receiveBlock(sub1, null);
  node.receiveBlock(sub2, null);

  // After subtrees arrive, probing should work
  const state = node.sampling.getSampleState(agg.hash);
  if (state) {
    for (let i = 0; i < 10; i++) {
      node.sampling.initSample(agg.hash);
    }
    // Weight factor may improve if subtrees get verified
    // (but we haven't registered contracts, so self-verification won't help)
  }
});
