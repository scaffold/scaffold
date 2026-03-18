/**
 * Network consensus convergence tests.
 *
 * Verifies that all nodes converge on the same canonical view
 * regardless of topology, timing, or arrival order.
 */

import { assert, assertEquals } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Consensus: linear chain -- all nodes agree on canonical order', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Build a linear chain of 5 blocks
  const blocks = [];
  let prev = genesis;
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(`chain-${i}`, prev, [makeOutput(10)], 10 + i);
    blocks.push(b);
    net.submitAndFlush(b, ['A', 'B', 'C', 'D', 'E'][i]);
    prev = b;
  }

  // All nodes should agree on canonical view
  net.assertAllAgree();
  for (const b of blocks) {
    net.assertAllCanonical(b.hash);
  }
});

Deno.test('Consensus: competing branches -- higher weight wins everywhere', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Two blocks claiming the same output, different weights
  const heavy = makeBlock('heavy', genesis, [makeOutput(100)], 50, [1]);
  const light = makeBlock('light', genesis, [makeOutput(100)], 10, [1]);

  // Deliver both to all nodes
  net.submitAndFlush(heavy, 'A');
  net.submitAndFlush(light, 'B');

  // Higher weight should win on all nodes
  net.assertAllCanonical(heavy.hash);
  net.assertNoneCanonical(light.hash);
  net.assertAllAgree();
});

Deno.test('Consensus: descendant weight flips winner across all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Two blocks: A has weight 10, B has weight 15
  const blockA = makeBlock('flipA', genesis, [makeOutput(100)], 10, [1]);
  const blockB = makeBlock('flipB', genesis, [makeOutput(100)], 15, [1]);

  net.submitAndFlush(blockA, 'A');
  net.submitAndFlush(blockB, 'B');

  // B should be winning initially (15 > 10)
  net.assertAllCanonical(blockB.hash);
  net.assertNoneCanonical(blockA.hash);

  // Heavy descendant of A flips the winner
  const childA = makeBlock('childA', blockA, [], 100);
  net.submitAndFlush(childA, 'A');

  // A should now win (effective 10 + 100 = 110 vs 15)
  net.assertAllCanonical(blockA.hash);
  net.assertNoneCanonical(blockB.hash);
  net.assertAllAgree();
});

Deno.test('Consensus: different arrival orders produce same canonical view', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Create blocks with varying weights
  const b1 = makeBlock('order-b1', genesis, [makeOutput(50)], 30);
  const b2 = makeBlock('order-b2', genesis, [makeOutput(50)], 20);
  const b3 = makeBlock('order-b3', genesis, [makeOutput(50)], 10);

  // Deliver in different orders to each node
  net.deliverDirect(b1, 'A');
  net.deliverDirect(b2, 'A');
  net.deliverDirect(b3, 'A');

  net.deliverDirect(b3, 'B');
  net.deliverDirect(b1, 'B');
  net.deliverDirect(b2, 'B');

  net.deliverDirect(b2, 'C');
  net.deliverDirect(b3, 'C');
  net.deliverDirect(b1, 'C');

  // All should agree on canonical view
  net.assertAllAgree();
});

Deno.test('Consensus: weight tie broken by hash consistently', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Two blocks with identical weight claiming same output
  const tieA = makeBlock('tie-alpha', genesis, [makeOutput(100)], 25, [1]);
  const tieB = makeBlock('tie-bravo', genesis, [makeOutput(100)], 25, [1]);

  // Deliver in different orders to different nodes
  net.deliverDirect(tieA, 'A');
  net.deliverDirect(tieB, 'A');

  net.deliverDirect(tieB, 'B');
  net.deliverDirect(tieA, 'B');

  net.deliverDirect(tieA, 'C');
  net.deliverDirect(tieB, 'C');

  net.deliverDirect(tieB, 'D');
  net.deliverDirect(tieA, 'D');

  net.deliverDirect(tieA, 'E');
  net.deliverDirect(tieB, 'E');

  // All must agree -- tie broken by hash deterministically
  net.assertAllAgree();
});

Deno.test('Consensus: deep chain stability', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Build a deep chain of 20 blocks
  let prev = genesis;
  for (let i = 0; i < 20; i++) {
    const b = makeBlock(`deep-${i}`, prev, [makeOutput(10)], 5);
    net.submitAndFlush(b, ['A', 'B', 'C'][i % 3]);
    prev = b;
  }

  net.assertAllAgree();
  // The deepest block should be canonical
  net.assertAllCanonical(prev.hash);
});

Deno.test('Consensus: multiple independent conflicts resolved consistently', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Conflict 1: two blocks claiming output 0
  const c1a = makeBlock('c1a', genesis, [makeOutput(100)], 40, [1]);
  const c1b = makeBlock('c1b', genesis, [makeOutput(100)], 20, [1]);

  // Conflict 2: two blocks claiming output 1
  const c2a = makeBlock('c2a', genesis, [makeOutput(200)], 15, [2]);
  const c2b = makeBlock('c2b', genesis, [makeOutput(200)], 35, [2]);

  // Deliver all to all nodes
  net.deliverToAll(c1a, 'A');
  net.deliverToAll(c1b, 'B');
  net.deliverToAll(c2a, 'C');
  net.deliverToAll(c2b, 'D');

  // All should agree: c1a wins conflict 1 (40 > 20), c2b wins conflict 2 (35 > 15)
  net.assertAllAgree();
  net.assertAllCanonical(c1a.hash);
  net.assertNoneCanonical(c1b.hash);
  net.assertAllCanonical(c2b.hash);
  net.assertNoneCanonical(c2a.hash);
});

Deno.test('Consensus: canonical view grows monotonically with non-conflicting blocks', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  let prevSize = net.canonicalSize('A');

  // Add non-conflicting blocks; canonical view should only grow
  let prev = genesis;
  for (let i = 0; i < 10; i++) {
    const b = makeBlock(`mono-${i}`, prev, [makeOutput(10)], 5);
    net.deliverDirect(b, 'A');
    const newSize = net.canonicalSize('A');
    assert(newSize >= prevSize, `Canonical view shrank from ${prevSize} to ${newSize}`);
    prevSize = newSize;
    prev = b;
  }
});
