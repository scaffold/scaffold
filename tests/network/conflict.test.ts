/**
 * Network conflict detection and resolution tests.
 *
 * Verifies that conflicts are detected symmetrically across all nodes
 * and that resolution is consistent regardless of arrival order.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Conflict: same-anchor conflict detected on all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Two blocks claiming the same output
  const blockX = makeBlock('conf-X', genesis, [makeOutput(100)], 30, [1]);
  const blockY = makeBlock('conf-Y', genesis, [makeOutput(100)], 20, [1]);

  net.deliverToAll(blockX, 'A');
  net.deliverToAll(blockY, 'B');

  // All nodes should detect the conflict
  for (const id of net.nodeIds) {
    const node = net.getNode(id);
    assert(
      node.conflict.hasConflict(blockX.hash, blockY.hash),
      `Node ${id} should detect conflict between X and Y`,
    );
  }
});

Deno.test('Conflict: winner consistent across all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C', 'D', 'E']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const winner = makeBlock('winner', genesis, [makeOutput(100)], 50, [1]);
  const loser = makeBlock('loser', genesis, [makeOutput(100)], 10, [1]);

  // Deliver in opposite orders to different halves of the network
  net.deliverDirect(winner, 'A');
  net.deliverDirect(loser, 'A');

  net.deliverDirect(loser, 'B');
  net.deliverDirect(winner, 'B');

  net.deliverDirect(winner, 'C');
  net.deliverDirect(loser, 'C');

  net.deliverDirect(loser, 'D');
  net.deliverDirect(winner, 'D');

  net.deliverDirect(winner, 'E');
  net.deliverDirect(loser, 'E');

  net.assertAllCanonical(winner.hash);
  net.assertNoneCanonical(loser.hash);
  net.assertAllAgree();
});

Deno.test('Conflict: three-way conflict -- three blocks claim same output', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const b1 = makeBlock('three-1', genesis, [makeOutput(100)], 30, [1]);
  const b2 = makeBlock('three-2', genesis, [makeOutput(100)], 20, [1]);
  const b3 = makeBlock('three-3', genesis, [makeOutput(100)], 10, [1]);

  net.deliverToAll(b1, 'A');
  net.deliverToAll(b2, 'B');
  net.deliverToAll(b3, 'C');

  // b1 has highest weight, should win
  net.assertAllCanonical(b1.hash);
  net.assertNoneCanonical(b2.hash);
  net.assertNoneCanonical(b3.hash);
  net.assertAllAgree();
});

Deno.test('Conflict: different declared weights', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Weights: 100, 50, 75 -- all claiming same output
  const heavy = makeBlock('heavy', genesis, [makeOutput(100)], 100, [1]);
  const medium = makeBlock('medium', genesis, [makeOutput(100)], 75, [1]);
  const light = makeBlock('light', genesis, [makeOutput(100)], 50, [1]);

  net.deliverToAll(light, 'A');
  net.deliverToAll(medium, 'B');
  net.deliverToAll(heavy, 'C');

  net.assertAllCanonical(heavy.hash);
  net.assertNoneCanonical(medium.hash);
  net.assertNoneCanonical(light.hash);
  net.assertAllAgree();
});

Deno.test('Conflict: transitive -- descendants of loser are also non-canonical', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Two competing blocks
  const winner = makeBlock('tw', genesis, [makeOutput(100)], 50, [1]);
  const loser = makeBlock('tl', genesis, [makeOutput(100)], 10, [1]);

  // Descendant of the loser
  const loserChild = makeBlock('tl-child', loser, [makeOutput(50)], 5);

  net.deliverToAll(winner, 'A');
  net.deliverToAll(loser, 'B');
  net.deliverToAll(loserChild, 'B');

  // Winner is canonical, loser and its child are not
  net.assertAllCanonical(winner.hash);
  net.assertNoneCanonical(loser.hash);
  net.assertNoneCanonical(loserChild.hash);
  net.assertAllAgree();
});

Deno.test('Conflict: winner flip when heavy descendant arrives', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  const blockA = makeBlock('flip-a', genesis, [makeOutput(100)], 10, [1]);
  const blockB = makeBlock('flip-b', genesis, [makeOutput(100)], 20, [1]);

  net.deliverToAll(blockA, 'A');
  net.deliverToAll(blockB, 'B');

  // B wins initially
  net.assertAllCanonical(blockB.hash);
  net.assertNoneCanonical(blockA.hash);

  // Heavy descendant of A
  const heavyChild = makeBlock('heavy-child', blockA, [], 200);
  net.deliverToAll(heavyChild, 'A');

  // A should now win on all nodes
  net.assertAllCanonical(blockA.hash);
  net.assertNoneCanonical(blockB.hash);
  net.assertAllAgree();
});

Deno.test('Conflict: independent conflicts do not interfere', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Conflict 1: output 0 (extended index 1)
  const c1Winner = makeBlock('ind-c1w', genesis, [makeOutput(100)], 40, [1]);
  const c1Loser = makeBlock('ind-c1l', genesis, [makeOutput(100)], 10, [1]);

  // Conflict 2: output 1 (extended index 2) -- independent
  const c2Winner = makeBlock('ind-c2w', genesis, [makeOutput(200)], 35, [2]);
  const c2Loser = makeBlock('ind-c2l', genesis, [makeOutput(200)], 15, [2]);

  net.deliverToAll(c1Winner, 'A');
  net.deliverToAll(c1Loser, 'B');
  net.deliverToAll(c2Winner, 'A');
  net.deliverToAll(c2Loser, 'B');

  // Both conflict winners should be canonical
  net.assertAllCanonical(c1Winner.hash);
  net.assertNoneCanonical(c1Loser.hash);
  net.assertAllCanonical(c2Winner.hash);
  net.assertNoneCanonical(c2Loser.hash);

  // Winners don't conflict with each other
  for (const id of net.nodeIds) {
    const node = net.getNode(id);
    assertFalse(
      node.conflict.hasConflict(c1Winner.hash, c2Winner.hash),
      `Node ${id}: independent winners should not conflict`,
    );
  }

  net.assertAllAgree();
});

Deno.test('Conflict: conflict at different chain depths resolved consistently', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  const genesis = makeGenesis(4);
  net.broadcastGenesis(genesis);

  // Block at depth 1
  const depth1 = makeBlock('depth1', genesis, [makeOutput(100)], 20, [1]);
  net.deliverToAll(depth1, 'A');

  // Block at depth 2, anchored to depth1
  const depth2 = makeBlock('depth2', depth1, [makeOutput(50)], 15);
  net.deliverToAll(depth2, 'A');

  // Competing block also anchored to genesis, claiming same output
  const competitor = makeBlock('depth-comp', genesis, [makeOutput(100)], 10, [1]);
  net.deliverToAll(competitor, 'B');

  // depth1 has effective weight 20 + 15 = 35 vs competitor's 10
  net.assertAllCanonical(depth1.hash);
  net.assertNoneCanonical(competitor.hash);
  net.assertAllAgree();
});
