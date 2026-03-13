import { assert, assertEquals, assertFalse } from '@std/assert';
import { DemoNode } from '../../src/demo/DemoNode.ts';
import { deriveIdentity } from '../../src/demo/Identity.ts';
import { signBlock } from '../../src/demo/SignedBlock.ts';
import { makeStatusOutput } from '../../src/demo/StatusContract.ts';
import { BlockSpec } from '../../src/core/BlockCreationModule.ts';
import { createBlock } from '../../src/core/Block.ts';

Deno.test('DemoNode: publish valid status update', () => {
  const node = new DemoNode('eagle');
  const result = node.publishStatus('eagle', 'Hello world');

  assert(result.ok, `Expected ok but got: ${result.error}`);
  assertEquals(node.statusIndex.getStatus('eagle'), 'Hello world');
});

Deno.test('DemoNode: two nodes — valid status propagates via method call', () => {
  const nodeA = new DemoNode('eagle');
  const nodeB = new DemoNode('badger');

  // Eagle publishes their own status
  const result = nodeA.publishStatus('eagle', 'Eagle says hi');
  assert(result.ok);

  // Manually propagate the block from A to B
  const chain = nodeA.getCanonicalChain();
  const latestBlock = chain[chain.length - 1];
  const sig = nodeA.signatureStore.get(latestBlock.hash.toPrimitive());
  assert(sig, 'Signature should be stored');

  nodeB.receiveSignedBlock({ block: latestBlock, signature: sig! }, 'nodeA');

  assertEquals(nodeB.statusIndex.getStatus('eagle'), 'Eagle says hi');
});

Deno.test('DemoNode: invalid block (wrong signer) rejected by receiving node', () => {
  const nodeA = new DemoNode('eagle');
  const nodeB = new DemoNode('badger');

  // Eagle tries to publish as badger (impersonation)
  const result = nodeA.publishStatus('badger', 'Fake message');
  assertFalse(result.ok);
  assert(result.error?.includes('signature'));

  // Even though the block was "sent" (in production it would go over WS),
  // let's manually try to deliver it to nodeB — it should be rejected
  // Since publishStatus doesn't accept locally on failure, the block isn't in the chain.
  // But we can construct the invalid block directly:
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

  const buildResult = nodeA.blockCreation.buildBlock(spec);
  assert(buildResult.ok);
  if (!buildResult.ok) return;

  const block = createBlock(buildResult.blueprint, nodeA.tip);
  const sb = signBlock(block, eagle.privateKey); // signed by eagle, not badger!

  // nodeB should reject this
  const beforeTip = nodeB.tip.hash.toPrimitive();
  nodeB.receiveSignedBlock(sb, 'nodeA');
  // Tip should not have changed (block rejected)
  assertEquals(nodeB.tip.hash.toPrimitive(), beforeTip);
  // Badger's status should not be updated
  assertEquals(nodeB.statusIndex.getStatus('badger'), '');
});

Deno.test('DemoNode: status update correctly claims old output and produces new one', () => {
  const node = new DemoNode('eagle');

  const result1 = node.publishStatus('eagle', 'First message');
  assert(result1.ok);
  assertEquals(node.statusIndex.getStatus('eagle'), 'First message');

  // The chain should have genesis + 1 block
  assertEquals(node.getCanonicalChain().length, 2);
});

Deno.test('DemoNode: multiple updates by same identity chain correctly', () => {
  const node = new DemoNode('eagle');

  const result1 = node.publishStatus('eagle', 'Message 1');
  assert(result1.ok);
  assertEquals(node.statusIndex.getStatus('eagle'), 'Message 1');

  const result2 = node.publishStatus('eagle', 'Message 2');
  assert(result2.ok);
  assertEquals(node.statusIndex.getStatus('eagle'), 'Message 2');

  const result3 = node.publishStatus('eagle', 'Message 3');
  assert(result3.ok);
  assertEquals(node.statusIndex.getStatus('eagle'), 'Message 3');

  // Chain should have genesis + 3 blocks
  assertEquals(node.getCanonicalChain().length, 4);
});

Deno.test('DemoNode: pub badger Hello as eagle → block sent but peers reject', () => {
  const eagleNode = new DemoNode('eagle');
  const badgerNode = new DemoNode('badger');

  // Eagle tries to publish as badger
  const result = eagleNode.publishStatus('badger', 'Hello');
  assertFalse(result.ok);

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

  const buildResult = eagleNode.blockCreation.buildBlock(spec);
  assert(buildResult.ok);
  if (!buildResult.ok) return;

  const block = createBlock(buildResult.blueprint, eagleNode.tip);
  const sb = signBlock(block, eagle.privateKey);

  // badgerNode should reject this impersonation
  badgerNode.receiveSignedBlock(sb, 'eagle');
  assertFalse(badgerNode.store.has(block.hash));
});
