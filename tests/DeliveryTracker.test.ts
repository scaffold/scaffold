import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { DeliveryTracker } from '../src/node/DeliveryTracker.ts';

// -- Test Helpers ---------------------------------------------------

/** Deterministic hash from a string. */
const h = (name: string): Hash => Hash.digest(name);

// -- Tests ----------------------------------------------------------

Deno.test({
  name: 'DeliveryTracker: markSent / wasSent',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('block-1');

  assertFalse(tracker.wasSent(block, 'alice'));

  tracker.markSent(block, 'alice');
  assert(tracker.wasSent(block, 'alice'));

  // Different peer should not be affected.
  assertFalse(tracker.wasSent(block, 'bob'));
});

Deno.test({
  name: 'DeliveryTracker: markDelivered / wasDelivered',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('block-2');

  assertFalse(tracker.wasDelivered(block, 'alice'));

  tracker.markSent(block, 'alice');
  assertFalse(tracker.wasDelivered(block, 'alice'));

  tracker.markDelivered(block, 'alice');
  assert(tracker.wasDelivered(block, 'alice'));

  // wasSent should still be true after delivery.
  assert(tracker.wasSent(block, 'alice'));
});

Deno.test({
  name: 'DeliveryTracker: markDelivered without prior markSent',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('block-3');

  // Directly marking delivered (e.g. peer told us they have it already).
  tracker.markDelivered(block, 'carol');
  assert(tracker.wasDelivered(block, 'carol'));
  assert(tracker.wasSent(block, 'carol'));
});

Deno.test({
  name: 'DeliveryTracker: markSent does not regress from delivered',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('block-4');

  tracker.markDelivered(block, 'alice');
  // Calling markSent after delivery should not regress the state.
  tracker.markSent(block, 'alice');
  assert(tracker.wasDelivered(block, 'alice'));
});

Deno.test({
  name: 'DeliveryTracker: getUnsent returns peers that have not received a block',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('block-5');

  const allPeers = ['alice', 'bob', 'carol'];

  // Nobody has been sent the block yet.
  assertEquals(tracker.getUnsent(block, allPeers), ['alice', 'bob', 'carol']);

  // Send to alice.
  tracker.markSent(block, 'alice');
  assertEquals(tracker.getUnsent(block, allPeers), ['bob', 'carol']);

  // Deliver to bob.
  tracker.markDelivered(block, 'bob');
  assertEquals(tracker.getUnsent(block, allPeers), ['carol']);

  // Send to carol.
  tracker.markSent(block, 'carol');
  assertEquals(tracker.getUnsent(block, allPeers), []);
});

Deno.test({
  name: 'DeliveryTracker: getUnsent with unknown block returns all peers',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('never-tracked');
  const allPeers = ['alice', 'bob'];

  assertEquals(tracker.getUnsent(block, allPeers), ['alice', 'bob']);
});

Deno.test({
  name: 'DeliveryTracker: forget cleans up all tracking for a block',
}, () => {
  const tracker = new DeliveryTracker();
  const block = h('block-6');

  tracker.markSent(block, 'alice');
  tracker.markDelivered(block, 'bob');

  assert(tracker.wasSent(block, 'alice'));
  assert(tracker.wasDelivered(block, 'bob'));

  tracker.forget(block);

  assertFalse(tracker.wasSent(block, 'alice'));
  assertFalse(tracker.wasDelivered(block, 'bob'));
  assertEquals(tracker.getUnsent(block, ['alice', 'bob']), ['alice', 'bob']);
});

Deno.test({
  name: 'DeliveryTracker: independent blocks do not interfere',
}, () => {
  const tracker = new DeliveryTracker();
  const blockA = h('block-a');
  const blockB = h('block-b');

  tracker.markSent(blockA, 'alice');
  tracker.markDelivered(blockB, 'alice');

  assert(tracker.wasSent(blockA, 'alice'));
  assertFalse(tracker.wasDelivered(blockA, 'alice'));

  assert(tracker.wasSent(blockB, 'alice'));
  assert(tracker.wasDelivered(blockB, 'alice'));

  // Forgetting one block should not affect the other.
  tracker.forget(blockA);
  assertFalse(tracker.wasSent(blockA, 'alice'));
  assert(tracker.wasDelivered(blockB, 'alice'));
});
