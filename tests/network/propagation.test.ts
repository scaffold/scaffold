/**
 * Network propagation tests.
 *
 * Verifies that blocks propagate correctly across multi-node networks
 * via gossip push actions.
 */

import { assert, assertEquals } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeLeafBlock, makeOutput } from './helpers.ts';

Deno.test('Propagation: two nodes -- block on A reaches B via gossip', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  const block = makeBlock('b1', genesis, [makeOutput(50)], 10);
  net.submitAndFlush(block, 'A');

  net.assertAllHave(block.hash);
  net.assertAllCanonical(block.hash);
});

Deno.test('Propagation: five fully-connected nodes -- block reaches all', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const block = makeBlock('b1', genesis, [makeOutput(50)], 10);
  net.submitAndFlush(block, 'A');

  net.assertAllHave(block.hash);
  net.assertAllCanonical(block.hash);
  net.assertAllAgree();
});

Deno.test('Propagation: genesis broadcast reaches all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  net.assertAllHave(genesis.hash);
  net.assertAllCanonical(genesis.hash);
});

Deno.test('Propagation: multiple blocks propagate in sequence', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Three blocks in a chain, each published from a different node
  const b1 = makeBlock('b1', genesis, [makeOutput(50)], 10);
  net.submitAndFlush(b1, 'A');

  const b2 = makeBlock('b2', b1, [makeOutput(25)], 20);
  net.submitAndFlush(b2, 'B');

  const b3 = makeBlock('b3', b2, [makeOutput(12)], 30);
  net.submitAndFlush(b3, 'C');

  net.assertAllHave(b1.hash);
  net.assertAllHave(b2.hash);
  net.assertAllHave(b3.hash);
  net.assertAllAgree();
});

Deno.test('Propagation: duplicate delivery is idempotent', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  const block = makeBlock('b1', genesis, [makeOutput(50)], 10);

  // Deliver to A twice
  net.deliverDirect(block, 'A');
  const r2 = net.deliverDirect(block, 'A');

  // Second delivery should produce no new conflicts or changes
  assertEquals(r2.newConflicts.length, 0);

  // Canonical view should be consistent
  assert(net.getNode('A').consensus.isCanonical(block.hash));
});

Deno.test('Propagation: multi-hop A->B->C in line topology', () => {
  const net = new TestNetwork();
  // Create nodes without auto-connect
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);

  // Connect in a line: A--B--C (A and C cannot directly reach each other)
  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  const block = makeBlock('b1', genesis, [makeOutput(50)], 10);
  net.submitAndFlush(block, 'A');

  // Block should reach B directly from A, then B should push to C
  net.assertAllHave(block.hash);
});

Deno.test('Propagation: fan-out -- one publisher, many receivers', () => {
  const net = new TestNetwork();
  // One publisher connected to 10 receivers
  net.addNode('publisher', false);
  for (let i = 0; i < 10; i++) {
    net.addNode(`r${i}`, false);
    net.connectPeers('publisher', `r${i}`);
  }

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  const block = makeBlock('b1', genesis, [makeOutput(50)], 10);
  net.submitAndFlush(block, 'publisher');

  // All receivers should have the block
  for (let i = 0; i < 10; i++) {
    net.assertNodeHas(`r${i}`, block.hash);
  }
});

Deno.test('Propagation: block with claims propagates correctly', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Block claims output index 1 (extended index 1 = anchor output 0)
  const block = makeBlock('claimer', genesis, [makeOutput(100)], 10, [1]);
  net.submitAndFlush(block, 'A');

  // All nodes should have the block and see it as canonical
  net.assertAllHave(block.hash);
  net.assertAllCanonical(block.hash);
  net.assertAllAgree();
});
