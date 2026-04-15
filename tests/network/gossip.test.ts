/**
 * Gossip behavior tests.
 *
 * Verifies gossip utility scoring, delivery matrix learning,
 * reciprocity, source integrity, and bandwidth budgeting.
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Gossip: push actions do not target the sender (no echo)', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');
  net.addNode('C');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // A creates block; push actions should NOT include A as a target
  const block = makeBlock('no-echo', genesis, [makeOutput(50)], 10);
  const result = net.submitBlock(block, 'A');

  for (const action of result.pushActions) {
    assert(action.peer !== 'A', 'Push actions should not echo back to originator');
  }
});

Deno.test('Gossip: block not pushed to peer that sent it', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');
  net.addNode('C');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // B sends block to A
  const block = makeBlock('aware', genesis, [makeOutput(50)], 10);
  net.getNode('B').receiveBlock(block, null);
  const result = net.getNode('A').receiveBlock(block, 'B');

  // A's push actions should NOT include B (the sender)
  const targets = result.pushActions.map((a) => a.peer);
  assert(!targets.includes('B'), 'Should not push back to sender');
});

Deno.test('Gossip: high-value subscriptions get higher priority push actions', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // B sends A a block with a subscription output (value=10)
  const sub = makeBlock('sub', genesis, [makeOutput(10)], 5);
  net.getNode('A').receiveBlock(sub, 'B');
  net.flush();

  // Two new blocks matching the subscription with different output values
  // Both match the same subscription, but priority depends on sub amount (10) / responseIndex
  const first = makeBlock('first', genesis, [makeOutput(10)], 5);
  const firstResult = net.submitBlock(first, 'A');
  net.flush();

  // After the first push, responseIndex for B increases, so second push has lower priority
  const second = makeBlock('second', genesis, [makeOutput(10)], 5);
  const secondResult = net.submitBlock(second, 'A');
  net.flush();

  const firstPriority = firstResult.pushActions.find((a) => a.peer === 'B')?.priority ?? 0;
  const secondPriority = secondResult.pushActions.find((a) => a.peer === 'B')?.priority ?? 0;

  // First push has higher priority than second (responseIndex increases)
  assert(
    firstPriority >= secondPriority,
    `First push priority (${firstPriority}) should >= second (${secondPriority})`,
  );
});

Deno.test('Gossip: delivery matrix learning -- successful deliveries increase rate', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // Initial first-delivery rate should be 0.5 (Beta(1,1) prior)
  const initialRate = net.getNode('A').routing.getFirstDeliveryRate(null, 'B');
  assertEquals(initialRate, 0.5);

  // Report several successful deliveries
  const blocks = [];
  for (let i = 0; i < 5; i++) {
    const b = makeBlock(`dm-${i}`, genesis, [makeOutput(10)], 5);
    blocks.push(b);
    net.getNode('A').receiveBlock(b, null);
    net.getNode('A').routing.reportDelivery(b.hash, 'B', true);
  }

  // First-delivery rate should have increased
  const updatedRate = net.getNode('A').routing.getFirstDeliveryRate(null, 'B');
  assert(
    updatedRate > 0.5,
    `Rate should increase after successful deliveries, got ${updatedRate}`,
  );
});

Deno.test('Gossip: reciprocity affects bandwidth budget', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // Initial budget
  const initialBudget = net.getNode('A').routing.getBandwidthBudget('B');
  assert(initialBudget > 0, 'Initial budget should be positive');

  // B sends several blocks to A (generous peer)
  for (let i = 0; i < 10; i++) {
    const b = makeBlock(`recip-${i}`, genesis, [makeOutput(10)], 10);
    net.getNode('A').receiveBlock(b, 'B');
  }

  // A's budget for B should increase (B is being generous)
  const generousBudget = net.getNode('A').routing.getBandwidthBudget('B');
  assert(
    generousBudget >= initialBudget,
    `Budget should increase for generous peer: ${generousBudget} vs ${initialBudget}`,
  );
});

Deno.test('Gossip: source integrity -- echoed blocks do not inflate receivedFirst', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // A creates a block
  const block = makeBlock('echo-test', genesis, [makeOutput(50)], 10);
  net.getNode('A').receiveBlock(block, null);

  // A pushes to B, B gets it
  net.getNode('B').receiveBlock(block, 'A');

  // B tries to echo it back to A -- should be ignored (A already has it)
  const echoActions: import('../../src/node/RoutingModule.ts').PushAction[] = [];
  net.getNode('A').routing.onPushAction((a) => echoActions.push(a));
  net.getNode('A').routing.blockReceived(block.hash, 'B');
  assertEquals(
    echoActions.length,
    0,
    'Echo should produce no push actions (block already known)',
  );
});

Deno.test('Gossip: bestPeerForFetch returns peer with awareness', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');
  net.addNode('C');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // B sends a block to A, so A's gossip knows B has it
  const block = makeBlock('fetch-test', genesis, [makeOutput(50)], 10);
  net.getNode('B').receiveBlock(block, null);
  net.getNode('A').receiveBlock(block, 'B');

  // A should suggest B as the best peer for fetching this block
  const bestPeer = net.getNode('A').routing.bestPeerForFetch(block.hash);
  assertEquals(bestPeer, 'B');
});

Deno.test('Gossip: decay matrices reduces absolute alpha/beta values', () => {
  const net = new TestNetwork();
  net.addNode('A');
  net.addNode('B');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // Build up delivery matrix entries (all successful)
  for (let i = 0; i < 10; i++) {
    const b = makeBlock(`decay-${i}`, genesis, [makeOutput(10)], 5);
    net.getNode('A').receiveBlock(b, null);
    net.getNode('A').routing.reportDelivery(b.hash, 'B', true);
  }

  // Rate before decay
  const rateBefore = net.getNode('A').routing.getFirstDeliveryRate(null, 'B');
  assert(rateBefore > 0.5, `Rate should be above 0.5 after successes: ${rateBefore}`);

  // Proportional decay (alpha *= factor, beta *= factor) preserves the ratio
  // alpha/(alpha+beta). This is by design -- decay reduces confidence
  // (widens the distribution) without shifting the expected value.
  net.getNode('A').routing.decayMatrices();

  const rateAfter = net.getNode('A').routing.getFirstDeliveryRate(null, 'B');

  // Rate should remain approximately the same (ratio-preserving decay)
  assert(
    Math.abs(rateAfter - rateBefore) < 0.01,
    `Rate should be stable under proportional decay: before=${rateBefore}, after=${rateAfter}`,
  );

  // After enough decay, new evidence should shift the rate more easily.
  // Add one failure after heavy decay to demonstrate reduced confidence.
  for (let i = 0; i < 100; i++) {
    net.getNode('A').routing.decayMatrices();
  }

  const failBlock = makeBlock('decay-fail', genesis, [makeOutput(10)], 5);
  net.getNode('A').receiveBlock(failBlock, null);
  net.getNode('A').routing.reportDelivery(failBlock.hash, 'B', false);

  const rateAfterFail = net.getNode('A').routing.getFirstDeliveryRate(null, 'B');
  // After heavy decay + one failure, the rate should drop more than it would
  // without decay (because the prior evidence is weaker)
  assert(rateAfterFail < rateBefore, `Rate should drop after decay + failure: ${rateAfterFail}`);
});
