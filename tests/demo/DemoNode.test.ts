import { assert, assertEquals, assertThrows } from '@std/assert';
import { DemoNode } from '../../src/demo/DemoNode.ts';
import { deriveIdentity } from '../../src/demo/Identity.ts';
import { makeStatusOutput } from '../../src/demo/StatusContract.ts';
import { BlockSpec } from '../../src/core/BlockCreationModule.ts';
import { BlockPayload } from '../../src/core/Block.ts';
import { composeBlockPacket, parsePacket } from '../../src/core/Packet.ts';

Deno.test('DemoNode: publish valid status update', () => {
  const node = new DemoNode('eagle');
  node.publishStatus('eagle', 'Hello world');
  assertEquals(node.statusIndex.getStatus('eagle'), 'Hello world');
});

Deno.test('DemoNode: two nodes — valid status propagates via method call', () => {
  const nodeA = new DemoNode('eagle');
  const nodeB = new DemoNode('badger');

  // Eagle publishes their own status
  nodeA.publishStatus('eagle', 'Eagle says hi');

  // Manually propagate the block from A to B via raw packet
  const chain = nodeA.getCanonicalChain();
  const latestBlock = chain[chain.length - 1];
  const raw = nodeA.packetStore.get(latestBlock.hash.toPrimitive());
  assert(raw, 'Raw packet should be stored');

  const packet = parsePacket<BlockPayload>(raw!);
  assert(packet, 'Packet should parse');

  nodeB.receivePacket(packet!, 'nodeA');

  assertEquals(nodeB.statusIndex.getStatus('eagle'), 'Eagle says hi');
});

Deno.test('DemoNode: invalid block (wrong signer) rejected by receiving node', () => {
  const nodeA = new DemoNode('eagle');
  const nodeB = new DemoNode('badger');

  // Eagle tries to publish as badger (impersonation)
  assertThrows(
    () => nodeA.publishStatus('badger', 'Fake message'),
    Error,
    'signature',
  );

  // Construct the invalid block directly and try to deliver to nodeB
  const badger = deriveIdentity('badger');
  const eagle = deriveIdentity('eagle');

  const claimIdx = nodeA.statusIndex.findClaimIndex('badger', nodeA.tip, nodeA.store);
  assert(claimIdx !== undefined);

  const spec: BlockSpec = {
    anchor: nodeA.tip.hash,
    outputs: [makeStatusOutput(badger.publicKey, 'Impersonation')],
    claims: [{ index: 1 + claimIdx!, value: 1 }],
    declaredWeight: 1,
    aggregates: [],
    refs: [],
  };

  const blueprint = nodeA.blockCreation.buildBlock(spec);
  const { block, packet } = composeBlockPacket(blueprint, eagle.privateKey); // signed by eagle, not badger!

  // nodeB should reject this
  const beforeTip = nodeB.tip.hash.toPrimitive();
  nodeB.receivePacket(packet, 'nodeA');
  // Tip should not have changed (block rejected)
  assertEquals(nodeB.tip.hash.toPrimitive(), beforeTip);
  // Badger's status should not be updated
  assertEquals(nodeB.statusIndex.getStatus('badger'), '');
});

Deno.test('DemoNode: status update correctly claims old output and produces new one', () => {
  const node = new DemoNode('eagle');

  node.publishStatus('eagle', 'First message');
  assertEquals(node.statusIndex.getStatus('eagle'), 'First message');

  // The chain should have genesis + 1 block
  assertEquals(node.getCanonicalChain().length, 2);
});

Deno.test('DemoNode: multiple updates by same identity chain correctly', () => {
  const node = new DemoNode('eagle');

  node.publishStatus('eagle', 'Message 1');
  assertEquals(node.statusIndex.getStatus('eagle'), 'Message 1');

  node.publishStatus('eagle', 'Message 2');
  assertEquals(node.statusIndex.getStatus('eagle'), 'Message 2');

  node.publishStatus('eagle', 'Message 3');
  assertEquals(node.statusIndex.getStatus('eagle'), 'Message 3');

  // Chain should have genesis + 3 blocks
  assertEquals(node.getCanonicalChain().length, 4);
});

Deno.test('DemoNode: pub badger Hello as eagle → block sent but peers reject', () => {
  const eagleNode = new DemoNode('eagle');
  const badgerNode = new DemoNode('badger');

  // Eagle tries to publish as badger
  assertThrows(() => eagleNode.publishStatus('badger', 'Hello'));

  // Manually construct and send the invalid block to badgerNode
  const badger = deriveIdentity('badger');
  const eagle = deriveIdentity('eagle');

  const claimIdx = eagleNode.statusIndex.findClaimIndex('badger', eagleNode.tip, eagleNode.store);
  assert(claimIdx !== undefined);

  const spec: BlockSpec = {
    anchor: eagleNode.tip.hash,
    outputs: [makeStatusOutput(badger.publicKey, 'Hello')],
    claims: [{ index: 1 + claimIdx!, value: 1 }],
    declaredWeight: 1,
    aggregates: [],
    refs: [],
  };

  const blueprint = eagleNode.blockCreation.buildBlock(spec);
  const { block, packet } = composeBlockPacket(blueprint, eagle.privateKey);

  // badgerNode should reject this impersonation
  badgerNode.receivePacket(packet, 'eagle');
  assert(!badgerNode.store.has(block.hash));
});
