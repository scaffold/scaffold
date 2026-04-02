/**
 * Block arrival ordering tests.
 *
 * Verifies that protocol state is consistent regardless of the
 * order in which blocks arrive at each node.
 */

import { assert, assertEquals } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeOutput } from './helpers.ts';
import { Block } from '../../src/core/Block.ts';

Deno.test('Ordering: child delivered before parent -- both stored', () => {
  const net = new TestNetwork();
  net.addNode('A');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const parent = makeBlock('ord-parent', genesis, [makeOutput(50)], 10);
  const child = makeBlock('ord-child', parent, [makeOutput(25)], 20);

  // Deliver child first, then parent
  net.deliverDirect(child, 'A');
  net.deliverDirect(parent, 'A');

  // Both should be in store
  net.assertNodeHas('A', parent.hash);
  net.assertNodeHas('A', child.hash);
});

Deno.test('Ordering: random shuffled delivery produces same canonical view', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Build a tree of blocks
  const blocks: Block[] = [];
  for (let i = 0; i < 8; i++) {
    blocks.push(makeBlock(`shuf-${i}`, genesis, [makeOutput(10 + i)], 5 + i));
  }

  // Deliver in order to A
  for (const b of blocks) {
    net.deliverDirect(b, 'A');
  }

  // Deliver in reverse order to B
  for (let i = blocks.length - 1; i >= 0; i--) {
    net.deliverDirect(blocks[i], 'B');
  }

  // Deliver in shuffled order to C (deterministic shuffle via modular arithmetic)
  const shuffled = blocks.map((_, i) => blocks[(i * 5 + 3) % blocks.length]);
  for (const b of shuffled) {
    net.deliverDirect(b, 'C');
  }

  // All nodes should agree
  net.assertAllAgree();
});

Deno.test('Ordering: interleaved conflicting blocks produce same winner', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Create pairs of conflicting blocks
  const conflicts: [Block, Block][] = [];
  for (let i = 0; i < 4; i++) {
    const winner = makeBlock(`int-w-${i}`, genesis, [makeOutput(100)], 50 + i, [i + 1]);
    const loser = makeBlock(`int-l-${i}`, genesis, [makeOutput(100)], 10 + i, [i + 1]);
    conflicts.push([winner, loser]);
  }

  // Node A: winner first, then loser for each pair
  for (const [w, l] of conflicts) {
    net.deliverDirect(w, 'A');
    net.deliverDirect(l, 'A');
  }

  // Node B: loser first, then winner for each pair
  for (const [w, l] of conflicts) {
    net.deliverDirect(l, 'B');
    net.deliverDirect(w, 'B');
  }

  net.assertAllAgree();
});

Deno.test('Ordering: chain delivered bottom-up -- canonical view matches top-down', () => {
  const net = new TestNetwork();
  net.addNode('topdown');
  net.addNode('bottomup');

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Build a chain of 10 blocks
  const chain: Block[] = [];
  let prev = genesis;
  for (let i = 0; i < 10; i++) {
    const b = makeBlock(`chain-bu-${i}`, prev, [makeOutput(10)], 5);
    chain.push(b);
    prev = b;
  }

  // Deliver top-down to first node
  for (const b of chain) {
    net.deliverDirect(b, 'topdown');
  }

  // Deliver bottom-up to second node
  for (let i = chain.length - 1; i >= 0; i--) {
    net.deliverDirect(chain[i], 'bottomup');
  }

  // Both should have all blocks in store
  for (const b of chain) {
    net.assertNodeHas('topdown', b.hash);
    net.assertNodeHas('bottomup', b.hash);
  }

  // Canonical views should match
  net.assertAllAgree();
});

Deno.test('Ordering: concurrent block creation on multiple nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(10);
  net.broadcastGenesis(genesis);

  // Each node creates a block simultaneously (no conflicts -- different claims)
  const blocks: Block[] = [];
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(
      `concurrent-${i}`,
      genesis,
      [makeOutput(100)],
      10 + i,
      [i + 1], // Each claims a different output
    );
    blocks.push(b);
  }

  // All nodes create their blocks (self-originated)
  const nodeIds = ['A', 'B', 'C', 'D', 'E'];
  for (let i = 0; i < 5; i++) {
    net.submitBlock(blocks[i], nodeIds[i]);
  }

  // Flush all gossip
  net.flush();

  // All nodes should have all blocks and agree
  for (const b of blocks) {
    net.assertAllHave(b.hash);
    net.assertAllCanonical(b.hash);
  }
  net.assertAllAgree();
});

Deno.test('Ordering: alternating branches delivered to different nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Branch 1: chain of 5 blocks
  const branch1: Block[] = [];
  let prev1 = genesis;
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(`alt-br1-${i}`, prev1, [makeOutput(10)], 3);
    branch1.push(b);
    prev1 = b;
  }

  // Branch 2: chain of 5 blocks (non-conflicting, same anchor but no claims)
  const branch2: Block[] = [];
  let prev2 = genesis;
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(`alt-br2-${i}`, prev2, [makeOutput(10)], 3);
    branch2.push(b);
    prev2 = b;
  }

  // Node A: alternates branch1[0], branch2[0], branch1[1], branch2[1], ...
  for (let i = 0; i < 5; i++) {
    net.deliverDirect(branch1[i], 'A');
    net.deliverDirect(branch2[i], 'A');
  }

  // Node B: all of branch1, then all of branch2
  for (const b of branch1) net.deliverDirect(b, 'B');
  for (const b of branch2) net.deliverDirect(b, 'B');

  // Both should have all blocks and agree on canonical view
  net.assertAllAgree();
});
