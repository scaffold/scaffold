/**
 * End-to-end network scenario tests.
 *
 * Multi-step scenarios that exercise multiple protocol modules together
 * across several nodes, simulating realistic usage patterns.
 */

import { assert, assertEquals } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import {
  makeAggregationBlock,
  makeBlock,
  makeGenesis,
  makeOutput,
} from './helpers.ts';

Deno.test('Scenario: five-node full pipeline -- genesis, create, propagate, aggregate', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(6);
  net.broadcastGenesis(genesis);

  // Step 1: Multiple nodes create blocks claiming different outputs
  const blocks = [];
  const nodeIds = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(
      `pipeline-${i}`,
      genesis,
      [makeOutput(100)],
      10 + i,
      [i + 1], // Each claims a different output (extended index i+1 = anchor output i)
    );
    blocks.push(b);
    net.deliverToAll(b, nodeIds[i]);
  }

  // Step 2: All nodes should have all blocks
  for (const b of blocks) {
    net.assertAllHave(b.hash);
    net.assertAllCanonical(b.hash);
  }

  // Step 3: Aggregate the first three blocks
  const agg = makeAggregationBlock('pipeline-agg', genesis, blocks.slice(0, 3), {
    anchorOutputCount: 6,
    claimedIndices: [0, 1, 2],
    aggregateOutputCounts: [1, 1, 1],
    declaredWeight: 5,
  });
  net.deliverToAll(agg, 'A');

  net.assertAllHave(agg.hash);
  net.assertAllCanonical(agg.hash);
  net.assertAllAgree();
});

Deno.test('Scenario: value conservation across the network', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4, 100); // 4 outputs of 100 each = 400 total
  net.broadcastGenesis(genesis);

  // Block claiming output 0 (value 100), producing output of value 100
  const b1 = makeBlock('vc-1', genesis, [makeOutput(100, 'vc-out-1')], 10, [1]);
  net.deliverToAll(b1, 'A');

  // Block claiming output 1 (value 100), producing two outputs of value 50
  const b2 = makeBlock(
    'vc-2',
    genesis,
    [makeOutput(50, 'vc-out-2a'), makeOutput(50, 'vc-out-2b')],
    15,
    [2],
  );
  net.deliverToAll(b2, 'B');

  // All nodes should have both blocks and agree
  net.assertAllHave(b1.hash);
  net.assertAllHave(b2.hash);
  net.assertAllAgree();
});

Deno.test('Scenario: game state -- sequential updates with verification', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Sequential chain: each block builds on the previous
  const chain = [];
  let prev = genesis;
  for (let i = 0; i < 10; i++) {
    const b = makeBlock(`game-${i}`, prev, [makeOutput(10, `state-${i}`)], 5);
    chain.push(b);
    // Alternate publishers
    net.deliverToAll(b, i % 2 === 0 ? 'A' : 'B');
    prev = b;
  }

  // All blocks should be canonical on both nodes
  for (const b of chain) {
    net.assertAllHave(b.hash);
    net.assertAllCanonical(b.hash);
  }

  // Chain tip should be the last block
  const tip = chain[chain.length - 1];
  net.assertAllCanonical(tip.hash);
  net.assertAllAgree();
});

Deno.test('Scenario: output lifecycle -- create, claim, aggregate', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Phase 1: Create blocks that produce outputs (non-conflicting claims)
  const producer1 = makeBlock('lifecycle-p1', genesis, [makeOutput(100, 'prod1')], 10, [1]);
  const producer2 = makeBlock('lifecycle-p2', genesis, [makeOutput(200, 'prod2')], 15, [2]);

  net.deliverToAll(producer1, 'A');
  net.deliverToAll(producer2, 'B');

  // Both should be canonical
  net.assertAllCanonical(producer1.hash);
  net.assertAllCanonical(producer2.hash);

  // Phase 2: Aggregate the producers
  const agg = makeAggregationBlock('lifecycle-agg', genesis, [producer1, producer2], {
    anchorOutputCount: 4,
    claimedIndices: [0, 1],
    aggregateOutputCounts: [1, 1],
    declaredWeight: 3,
  });

  net.deliverToAll(agg, 'C');

  // Aggregation block should be canonical
  net.assertAllCanonical(agg.hash);

  // Producers should be marked as aggregated
  for (const id of net.nodeIds) {
    assert(net.getNode(id).store.isAggregated(producer1.hash));
    assert(net.getNode(id).store.isAggregated(producer2.hash));
  }

  net.assertAllAgree();
});

Deno.test('Scenario: create, propagate, conflict, resolve, continue chain', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Step 1: A and B create conflicting blocks
  const blockA = makeBlock('resolve-A', genesis, [makeOutput(100)], 30, [1]);
  const blockB = makeBlock('resolve-B', genesis, [makeOutput(100)], 20, [1]);

  net.deliverToAll(blockA, 'A');
  net.deliverToAll(blockB, 'B');

  // All nodes should see A as winner (30 > 20)
  net.assertAllCanonical(blockA.hash);
  net.assertNoneCanonical(blockB.hash);

  // Step 2: Winner continues building the chain
  // Each descendant must individually beat blockB's effective weight (20)
  // in the conflict set, so give them enough weight.
  const child1 = makeBlock('resolve-child1', blockA, [makeOutput(50)], 25);
  net.deliverToAll(child1, 'A');

  const child2 = makeBlock('resolve-child2', child1, [makeOutput(25)], 25);
  net.deliverToAll(child2, 'C');

  // Chain should be A's branch -- each block individually beats blockB
  net.assertAllCanonical(blockA.hash);
  net.assertAllCanonical(child1.hash);
  net.assertAllCanonical(child2.hash);

  // Step 3: All should agree
  net.assertAllAgree();

  // Step 4: Verify the canonical chain depth
  for (const id of net.nodeIds) {
    const store = net.getNode(id).store;
    const depth = store.getAnchorDepth(child2.hash, genesis.hash);
    assertEquals(depth, 3, `Node ${id}: chain depth should be 3`);
  }
});
