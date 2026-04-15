/**
 * Tests for the gossip subscription lifecycle wiring in NodeContext.
 *
 * Verifies that:
 * - Claim resolutions notify the gossip module (notifyClaimResolved)
 * - Canonical claims remove subscriptions (outputClaimed)
 * - Non-canonical reversals re-add subscriptions (outputUnclaimed)
 */
import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  Block,
  BlockSource,
  BlockStore,
  createGenesisBlock,
} from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { NodeConfig, NodeContext } from '../src/node/NodeContext.ts';
import { verifierKey } from '../src/node/UtxoIndex.ts';
import { SendAction } from '../src/node/GossipModule.ts';
import { PushAction } from '../src/node/RoutingModule.ts';

// -- Helpers --------------------------------------------------------

function makeOutput(value: number, label: string): Output {
  return {
    verifier: { contract: Hash.digest(label), params: new Uint8Array(0) },
    value,
    data: new Uint8Array([]),
  };
}

function vk(label: string): string {
  return verifierKey(Hash.digest(label), new Uint8Array(0));
}

function makeBlock(
  name: string,
  anchor: Hash,
  outputs: Output[],
  claims: number[],
  declaredWeight: number,
): Block {
  return {
    hash: Hash.digest(name),
    anchor,
    aggregates: [],
    claims,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
  };
}

function createContext(genesis: Block): NodeContext {
  const config: NodeConfig = {
    genesis,
    strategies: [],
  };
  return new NodeContext(config);
}

// -- Tests ----------------------------------------------------------

Deno.test('gossip lifecycle: claim resolution notifies gossip', () => {
  const genesis = createGenesisBlock([
    makeOutput(100, 'game'),
    makeOutput(200, 'game'),
  ]);
  const ctx = createContext(genesis);

  // Collect send actions from gossip
  const sendActions: SendAction[] = [];
  ctx.gossip.onSendAction((a) => sendActions.push(a));

  // Simulate receiving genesis from a "peer" to create a subscription.
  // In the real flow, routing.blockReceived adds subscription sources
  // for peer-received blocks. We call addSubscriptionSource directly.
  ctx.gossip.addSubscriptionSource(genesis.hash);

  // Genesis outputs should be in the subscription index
  const V = vk('game');
  assertEquals(ctx.gossip.getSubscriptionCount(V), 2);

  // Block A claims genesis output 0 (claim index 1 = own outputs(1) + ext 0)
  const blockA = makeBlock('A', genesis.hash, [makeOutput(100, 'A-out')], [1], 10);
  ctx.processBlock(blockA);

  // The claim resolution should have triggered notifyClaimResolved,
  // which emits send actions to V subscribers
  const claimActions = sendActions.filter(
    (a) => Hash.equals(a.block, blockA.hash),
  );
  assert(claimActions.length > 0, 'claim resolution should emit send actions');
});

Deno.test('gossip lifecycle: canonical claim removes subscription', () => {
  const genesis = createGenesisBlock([
    makeOutput(100, 'game'),
    makeOutput(200, 'pay'),
  ]);
  const ctx = createContext(genesis);

  // Add genesis as subscription source
  ctx.gossip.addSubscriptionSource(genesis.hash);

  const V_game = vk('game');
  const V_pay = vk('pay');
  assertEquals(ctx.gossip.getSubscriptionCount(V_game), 1);
  assertEquals(ctx.gossip.getSubscriptionCount(V_pay), 1);

  // Block claims genesis output 0 (game). Claim index 1 = outputs(1) + ext 0.
  const blockA = makeBlock('claimA', genesis.hash, [makeOutput(100, 'A-out')], [1], 10);
  ctx.processBlock(blockA);

  // blockA should be canonical (no conflict), so the claimed subscription
  // should be removed
  assert(ctx.consensus.isCanonical(blockA.hash));
  assertEquals(ctx.gossip.getSubscriptionCount(V_game), 0);

  // The 'pay' subscription should still be present (not claimed)
  assertEquals(ctx.gossip.getSubscriptionCount(V_pay), 1);
});

Deno.test('gossip lifecycle: canonical flip restores subscription', () => {
  const genesis = createGenesisBlock([
    makeOutput(100, 'game'),
    makeOutput(200, 'other'),
  ]);
  const ctx = createContext(genesis);

  ctx.gossip.addSubscriptionSource(genesis.hash);

  const V = vk('game');
  assertEquals(ctx.gossip.getSubscriptionCount(V), 1);

  // Two conflicting blocks claim the same genesis output
  // Block A: weight 10, claims extended index 0 (claim index 1, since own outputs = 1)
  const blockA = makeBlock('flipA', genesis.hash, [makeOutput(100, 'A-out')], [1], 10);
  // Block B: weight 15, claims same output
  const blockB = makeBlock('flipB', genesis.hash, [makeOutput(100, 'B-out')], [1], 15);

  ctx.processBlock(blockA);
  assert(ctx.consensus.isCanonical(blockA.hash));
  assertEquals(ctx.gossip.getSubscriptionCount(V), 0); // claimed by canonical A

  ctx.processBlock(blockB);
  // B has higher weight, should win; A becomes non-canonical
  assert(ctx.consensus.isCanonical(blockB.hash));

  // Both A and B claim the same output. The output should still be removed
  // from subscriptions (B is now canonical and claims it).
  assertEquals(ctx.gossip.getSubscriptionCount(V), 0);

  // Now add a descendant of A that makes A's subtree heavier
  const blockC = makeBlock('flipC', blockA.hash, [makeOutput(50, 'C-out')], [], 20);
  ctx.processBlock(blockC);

  // A's subtree weight: 10 + 20 = 30 > B's 15. A should flip back to canonical.
  assert(ctx.consensus.isCanonical(blockA.hash));

  // B is now non-canonical -- its claim should be reversed (outputUnclaimed).
  // But A is canonical and also claims the same output, so it stays removed.
  assertEquals(ctx.gossip.getSubscriptionCount(V), 0);
});

Deno.test('gossip lifecycle: non-conflicting unclaim restores subscription', () => {
  const genesis = createGenesisBlock([
    makeOutput(100, 'game'),
    makeOutput(200, 'pay'),
  ]);
  const ctx = createContext(genesis);

  ctx.gossip.addSubscriptionSource(genesis.hash);

  const V_game = vk('game');
  const V_pay = vk('pay');

  // Block A claims genesis output 0 (game) and output 1 (pay)
  // claim index 1 = own(1) + ext 0 = game
  // claim index 2 = own(1) + ext 1 = pay
  const blockA = makeBlock(
    'claim_both',
    genesis.hash,
    [makeOutput(300, 'A-out')],
    [1, 2],
    10,
  );
  ctx.processBlock(blockA);

  assert(ctx.consensus.isCanonical(blockA.hash));
  assertEquals(ctx.gossip.getSubscriptionCount(V_game), 0);
  assertEquals(ctx.gossip.getSubscriptionCount(V_pay), 0);

  // Block B conflicts with A (claims same game output)
  const blockB = makeBlock(
    'conflict_claim',
    genesis.hash,
    [makeOutput(100, 'B-out')],
    [1], // only claims game, not pay
    20, // higher weight wins
  );
  ctx.processBlock(blockB);

  // B wins, A is non-canonical. A's claims are reversed.
  assert(ctx.consensus.isCanonical(blockB.hash));

  // A's claim on game is reversed, but B also claims game -> still 0
  assertEquals(ctx.gossip.getSubscriptionCount(V_game), 0);

  // A's claim on pay is reversed. B doesn't claim pay -> restored to 1
  assertEquals(ctx.gossip.getSubscriptionCount(V_pay), 1);
});

Deno.test('gossip lifecycle: self-claim does not affect subscriptions', () => {
  const genesis = createGenesisBlock([
    makeOutput(100, 'game'),
  ]);
  const ctx = createContext(genesis);

  ctx.gossip.addSubscriptionSource(genesis.hash);

  const V = vk('game');
  assertEquals(ctx.gossip.getSubscriptionCount(V), 1);

  // Block with self-claim (claim index 0 < outputs.length = 2)
  const blockA = makeBlock(
    'self_claim',
    genesis.hash,
    [makeOutput(50, 'A-out1'), makeOutput(50, 'A-out2')],
    [0], // self-claim on own output 0
    10,
  );
  ctx.processBlock(blockA);

  // Self-claim should not affect genesis subscription
  assertEquals(ctx.gossip.getSubscriptionCount(V), 1);
});
