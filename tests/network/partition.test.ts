/**
 * Network partition and recovery tests.
 *
 * Verifies behavior when the network splits into disconnected groups,
 * and convergence after partitions heal.
 */

import { assert, assertFalse } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Partition: partition prevents block propagation', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // Partition A from B
  net.partition(['A'], ['B']);

  const block = makeBlock('part-1', genesis, [makeOutput(50)], 10);
  net.deliverDirect(block, 'A', null);

  // A should have it, B should not (partitioned)
  net.assertNodeHas('A', block.hash);
  net.assertNodeMissing('B', block.hash);
});

Deno.test('Partition: heal restores block propagation', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  net.partition(['A'], ['B']);

  const block = makeBlock('heal-1', genesis, [makeOutput(50)], 10);
  net.deliverDirect(block, 'A', null);

  net.assertNodeMissing('B', block.hash);

  // Heal and deliver to B explicitly
  net.heal(['A'], ['B']);
  net.deliverDirect(block, 'B', 'A');

  // B should now have the block
  net.assertNodeHas('B', block.hash);
});

Deno.test('Partition: both sides build independently', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Partition: {A, B} vs {C, D}
  net.partition(['A', 'B'], ['C', 'D']);

  // Left side builds a chain (deliver to both A and B)
  const leftBlock = makeBlock('left-1', genesis, [makeOutput(50)], 10);
  net.deliverDirect(leftBlock, 'A', null);
  net.deliverDirect(leftBlock, 'B', 'A');

  // Right side builds a different chain (deliver to both C and D)
  const rightBlock = makeBlock('right-1', genesis, [makeOutput(50)], 15);
  net.deliverDirect(rightBlock, 'C', null);
  net.deliverDirect(rightBlock, 'D', 'C');

  // Each side should have its own blocks
  net.assertNodeHas('A', leftBlock.hash);
  net.assertNodeHas('B', leftBlock.hash);
  net.assertNodeMissing('C', leftBlock.hash);
  net.assertNodeMissing('D', leftBlock.hash);

  net.assertNodeHas('C', rightBlock.hash);
  net.assertNodeHas('D', rightBlock.hash);
  net.assertNodeMissing('A', rightBlock.hash);
  net.assertNodeMissing('B', rightBlock.hash);

  // Each side should agree internally
  net.assertGroupAgrees(['A', 'B']);
  net.assertGroupAgrees(['C', 'D']);
});

Deno.test('Partition: conflicting blocks during partition resolved after heal', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Partition: {A, B} vs {C, D}
  net.partition(['A', 'B'], ['C', 'D']);

  // Both sides claim the same output (deliver within each partition group)
  const leftBlock = makeBlock('part-left', genesis, [makeOutput(100)], 30, [1]);
  net.deliverDirect(leftBlock, 'A', null);
  net.deliverDirect(leftBlock, 'B', 'A');

  const rightBlock = makeBlock('part-right', genesis, [makeOutput(100)], 50, [1]);
  net.deliverDirect(rightBlock, 'C', null);
  net.deliverDirect(rightBlock, 'D', 'C');

  // Each side thinks its block is canonical
  assert(net.getNode('A').consensus.isCanonical(leftBlock.hash));
  assert(net.getNode('C').consensus.isCanonical(rightBlock.hash));

  // Heal partition and deliver blocks that were created during partition
  net.healAll();
  net.deliverToAll(leftBlock, 'A');
  net.deliverToAll(rightBlock, 'C');

  // Now all should agree: rightBlock wins (weight 50 > 30)
  net.assertAllCanonical(rightBlock.hash);
  net.assertNoneCanonical(leftBlock.hash);
  net.assertAllAgree();
});

Deno.test('Partition: deep chains on both sides converge after heal', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  net.partition(['A', 'B'], ['C', 'D']);

  // Left side builds a deep chain
  let leftPrev = genesis;
  const leftBlocks = [];
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(`left-deep-${i}`, leftPrev, [makeOutput(10)], 5);
    leftBlocks.push(b);
    const src = i % 2 === 0 ? 'A' : 'B';
    const dst = i % 2 === 0 ? 'B' : 'A';
    net.deliverDirect(b, src, null);
    net.deliverDirect(b, dst, src);
    leftPrev = b;
  }

  // Right side builds its own chain
  let rightPrev = genesis;
  const rightBlocks = [];
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(`right-deep-${i}`, rightPrev, [makeOutput(10)], 5);
    rightBlocks.push(b);
    const src = i % 2 === 0 ? 'C' : 'D';
    const dst = i % 2 === 0 ? 'D' : 'C';
    net.deliverDirect(b, src, null);
    net.deliverDirect(b, dst, src);
    rightPrev = b;
  }

  // Heal and deliver all blocks to all nodes
  net.healAll();
  for (const b of leftBlocks) {
    net.deliverToAll(b, 'A');
  }
  for (const b of rightBlocks) {
    net.deliverToAll(b, 'C');
  }

  // All nodes should have all blocks
  for (const b of [...leftBlocks, ...rightBlocks]) {
    net.assertAllHave(b.hash);
  }

  // All should agree on canonical view
  net.assertAllAgree();
});

Deno.test('Partition: multiple partitions and heals', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Round 1: partition A from {B, C}
  net.partition(['A'], ['B', 'C']);

  const b1 = makeBlock('mp-1', genesis, [makeOutput(50)], 10);
  net.deliverDirect(b1, 'A', null);
  net.assertNodeMissing('B', b1.hash);

  // Heal and deliver b1 to all nodes
  net.healAll();
  net.deliverToAll(b1, 'A');
  net.assertAllHave(b1.hash);

  // Round 2: partition B from {A, C}
  net.partition(['B'], ['A', 'C']);

  const b2 = makeBlock('mp-2', b1, [makeOutput(25)], 20);
  net.deliverDirect(b2, 'B', null);
  net.assertNodeMissing('A', b2.hash);

  // Heal and deliver b2 to all nodes
  net.healAll();
  net.deliverToAll(b2, 'B');
  net.assertAllHave(b2.hash);
  net.assertAllAgree();
});

Deno.test('Partition: asymmetric -- A can reach B but B cannot reach A', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // Simulate asymmetric reachability: A->B works, B->A is blocked
  net.partition(['A'], ['B']); // Block both directions
  net.heal(['A'], ['B']); // Heal both (clean slate)

  // A creates a block and delivers to B (A can reach B)
  const blockA = makeBlock('asym-a', genesis, [makeOutput(50)], 10);
  net.deliverDirect(blockA, 'A', null);
  net.deliverDirect(blockA, 'B', 'A');
  net.assertNodeHas('A', blockA.hash);
  net.assertNodeHas('B', blockA.hash);

  // B creates a block but cannot reach A
  const blockB = makeBlock('asym-b', genesis, [makeOutput(50)], 15);
  net.deliverDirect(blockB, 'B', null);
  net.assertNodeHas('B', blockB.hash);
  net.assertNodeMissing('A', blockB.hash);

  // Once B->A link is restored, A gets B's block
  net.deliverDirect(blockB, 'A', 'B');
  net.assertNodeHas('A', blockB.hash);
});
