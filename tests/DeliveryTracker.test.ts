import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { DeliveryTracker } from '../src/node/DeliveryTracker.ts';

const h = (name: string): Hash => Hash.digest(name);

Deno.test('DeliveryTracker: markSent / wasSent', () => {
  const tracker = new DeliveryTracker();
  const block = h('block-1');

  assertFalse(tracker.wasSent(block, 'alice'));

  tracker.markSent(block, 'alice');
  assert(tracker.wasSent(block, 'alice'));

  assertFalse(tracker.wasSent(block, 'bob'));
});

Deno.test('DeliveryTracker: getUnsent returns peers that have not received a block', () => {
  const tracker = new DeliveryTracker();
  const block = h('block-5');
  const allPeers = ['alice', 'bob', 'carol'];

  assertEquals(tracker.getUnsent(block, allPeers), ['alice', 'bob', 'carol']);

  tracker.markSent(block, 'alice');
  assertEquals(tracker.getUnsent(block, allPeers), ['bob', 'carol']);

  tracker.markSent(block, 'bob');
  assertEquals(tracker.getUnsent(block, allPeers), ['carol']);
});

Deno.test('DeliveryTracker: getUnsent with unknown block returns all peers', () => {
  const tracker = new DeliveryTracker();
  assertEquals(tracker.getUnsent(h('unknown'), ['alice', 'bob']), ['alice', 'bob']);
});

Deno.test('DeliveryTracker: forget cleans up tracking for a block', () => {
  const tracker = new DeliveryTracker();
  const block = h('block-6');

  tracker.markSent(block, 'alice');
  assert(tracker.wasSent(block, 'alice'));

  tracker.forget(block);

  assertFalse(tracker.wasSent(block, 'alice'));
  assertEquals(tracker.getUnsent(block, ['alice']), ['alice']);
});

Deno.test('DeliveryTracker: independent blocks do not interfere', () => {
  const tracker = new DeliveryTracker();
  const blockA = h('block-a');
  const blockB = h('block-b');

  tracker.markSent(blockA, 'alice');
  tracker.markSent(blockB, 'bob');

  assert(tracker.wasSent(blockA, 'alice'));
  assertFalse(tracker.wasSent(blockA, 'bob'));
  assert(tracker.wasSent(blockB, 'bob'));
  assertFalse(tracker.wasSent(blockB, 'alice'));

  tracker.forget(blockA);
  assertFalse(tracker.wasSent(blockA, 'alice'));
  assert(tracker.wasSent(blockB, 'bob'));
});
