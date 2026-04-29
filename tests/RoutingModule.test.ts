import { assert, assertAlmostEquals, assertEquals, assertGreater, assertLess } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  BlockAwareness,
  PushAction,
  RoutingModule,
  RoutingProvider,
} from '../src/node/RoutingModule.ts';
import {
  BlockOutput,
  GossipModule,
  GossipProvider,
  SendAction,
  UnclaimedOutput,
  VerifierKey,
} from '../src/node/GossipModule.ts';

// -- Test helpers ------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);

function vk(label: string): VerifierKey {
  return Hash.digest(`contract:${label}`).toHex() + ':' +
    Array.from(new TextEncoder().encode(label))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
}

/** Simple set-based block awareness. */
class TestAwareness implements BlockAwareness {
  private readonly known = new Set<string>();
  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }
  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

/** In-memory routing provider. */
class TestRoutingProvider implements RoutingProvider {
  private sizes = new Map<string, number>();

  setSize(hash: Hash, size: number): void {
    this.sizes.set(hash.toPrimitive(), size);
  }

  getBlockSize(hash: Hash): number {
    return this.sizes.get(hash.toPrimitive()) ?? 100;
  }
}

/** In-memory gossip provider. */
class TestGossipProvider implements GossipProvider {
  private blocks = new Map<string, BlockOutput[]>();
  private utxos = new Map<string, UnclaimedOutput[]>();

  addBlock(hash: Hash, outputs: BlockOutput[]): void {
    this.blocks.set(hash.toPrimitive(), outputs);
  }

  setUnclaimed(verifierKey: VerifierKey, entries: UnclaimedOutput[]): void {
    this.utxos.set(verifierKey, entries);
  }

  getBlockOutputs(block: Hash): BlockOutput[] {
    return this.blocks.get(block.toPrimitive()) ?? [];
  }

  getUnclaimedOutputs(verifierKey: VerifierKey): UnclaimedOutput[] {
    return this.utxos.get(verifierKey) ?? [];
  }
}

function setup(config?: Partial<import('../src/node/RoutingModule.ts').RoutingConfig>) {
  const routingProvider = new TestRoutingProvider();
  const gossipProvider = new TestGossipProvider();
  const gossip = new GossipModule(gossipProvider);
  const routing = new RoutingModule(routingProvider, gossip, config);
  return { routingProvider, gossipProvider, gossip, routing };
}

function collectPushActions(routing: RoutingModule): PushAction[] {
  const actions: PushAction[] = [];
  routing.onPushAction((a) => actions.push(a));
  return actions;
}

/**
 * Helper: establish claim history for a verifier via a block that is
 * in a peer's receivedFirst. This simulates the Coordinator -> Gossip flow
 * where a claim resolves before the routing module processes the block.
 */
function establishClaimHistory(
  gossip: GossipModule,
  routing: RoutingModule,
  gossipProvider: TestGossipProvider,
  claimerHash: Hash,
  verifier: VerifierKey,
  amount: number,
  fromPeer: string,
): void {
  // Register the claimer block so gossip can read its outputs (may be empty)
  if (!gossipProvider.getBlockOutputs(claimerHash).length) {
    gossipProvider.addBlock(claimerHash, []);
  }
  // Simulate: claim resolves -> gossip claim history updated
  gossip.notifyClaimResolved(claimerHash, verifier, amount, h('source'));
  // Block arrives from peer -> enters receivedFirst
  routing.blockReceived(claimerHash, fromPeer);
}

// -- Peer lifecycle -----------------------------------------------

Deno.test('addPeer: registers peer state', () => {
  const { routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  assertEquals(routing.getPeerIds(), ['alice']);
});

Deno.test('addPeer: duplicate is no-op', () => {
  const { routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('alice', 'pk_alice2', new TestAwareness());
  assertEquals(routing.getPeerIds().length, 1);
});

Deno.test('removePeer: cleans up state', () => {
  const { routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.removePeer('alice');
  assertEquals(routing.getPeerIds().length, 0);
});

Deno.test('getPeerIds: returns current peers', () => {
  const { routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', new TestAwareness());
  assertEquals(routing.getPeerIds().sort(), ['alice', 'bob']);
});

// -- receivedFirst management ---------------------------------------

Deno.test('blockReceived: block from peer enters receivedFirst', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');

  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  // Alice sends a claiming block -> enters receivedFirst + claim history
  establishClaimHistory(gossip, routing, gossipProvider, h('claimer'), V, 10, 'alice');

  // New V-output block arrives -- should route toward alice (via claim history)
  const actions = collectPushActions(routing);
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  assert(actions.some((a) => a.peer === 'alice'));
});

Deno.test('blockReceived: self-originated block enters no receivedFirst', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');

  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  // Claim history exists for V, but the claiming block was self-originated
  gossipProvider.addBlock(h('claimer'), []);
  gossip.notifyClaimResolved(h('claimer'), V, 10, h('source'));
  routing.blockReceived(h('claimer'), null); // self-originated, not in receivedFirst

  const actions = collectPushActions(routing);
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  // No peer has h('claimer') in receivedFirst, so no routing
  assertEquals(actions.filter((a) => a.peer === 'alice' && a.verifier === V).length, 0);
});

Deno.test('blockReceived: source integrity (duplicate is no-op)', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('claimer'), V, 10, 'alice');

  // Duplicate blockReceived
  routing.blockReceived(h('claimer'), 'alice'); // no-op (already processed)

  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  const aliceActions = actions.filter((a) => a.peer === 'alice' && a.verifier === V);
  assertEquals(aliceActions.length, 1);
});

// -- Send action -> PushAction mapping -----------------------------

Deno.test('send action routes to peer with trigger in receivedFirst', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('trigger'), V, 10, 'alice');

  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  const matched = actions.filter((a) => a.peer === 'alice' && Hash.equals(a.block, h('new')));
  assertEquals(matched.length, 1);
});

Deno.test('send action: trigger not in any receivedFirst -> only baseline push', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  // Claim history exists but the claiming block is not in any receivedFirst
  gossipProvider.addBlock(h('claimer'), []);
  gossip.notifyClaimResolved(h('claimer'), V, 10, h('source'));
  // Don't call routing.blockReceived for claimer -- it's not in receivedFirst

  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  // Only baseline pushes (no claim history match routes through receivedFirst)
  const subscriptionMatched = actions.filter((a) => a.verifier !== undefined);
  assertEquals(subscriptionMatched.length, 0);
});

Deno.test('send action: different triggers per peer -> push to both', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', new TestAwareness());

  // Each peer sends a different claiming block
  establishClaimHistory(gossip, routing, gossipProvider, h('from_alice'), V, 10, 'alice');
  establishClaimHistory(gossip, routing, gossipProvider, h('from_bob'), V, 10, 'bob');

  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  const toAlice = actions.filter((a) => a.peer === 'alice' && Hash.equals(a.block, h('new')));
  const toBob = actions.filter((a) => a.peer === 'bob' && Hash.equals(a.block, h('new')));
  assert(toAlice.length >= 1, 'new block should be pushed to alice');
  assert(toBob.length >= 1, 'new block should be pushed to bob');
});

Deno.test('send action: dedup by (block, peer) keeps highest priority', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V1 = vk('game');
  const V2 = vk('pay');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  // Alice sends a block that establishes claim history for both verifiers
  const trigger = h('trigger');
  gossipProvider.addBlock(trigger, []);
  gossip.notifyClaimResolved(trigger, V1, 10, h('src1'));
  gossip.notifyClaimResolved(trigger, V2, 100, h('src2'));
  routing.blockReceived(trigger, 'alice');

  gossipProvider.addBlock(h('new'), [
    { index: 0, verifierKey: V1, value: 5 },
    { index: 1, verifierKey: V2, value: 5 },
  ]);
  routing.blockReceived(h('new'), null);

  // Only one push action for alice (deduped), with the higher priority
  const aliceActions = actions.filter((a) => a.peer === 'alice' && Hash.equals(a.block, h('new')));
  assertEquals(aliceActions.length, 1);
  // V2 claim history has higher amount (100 vs 10), so its priority should win
  assertEquals(aliceActions[0].verifier, V2);
});

Deno.test('send action: skip peer whose awareness already has block', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  const awareness = new TestAwareness();
  awareness.add(h('new')); // alice already knows about h('new')

  routing.addPeer('alice', 'pk_alice', awareness);
  establishClaimHistory(gossip, routing, gossipProvider, h('trigger'), V, 10, 'alice');

  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('new'), null);

  // Alice already has 'new', so no push
  const aliceActions = actions.filter((a) => a.peer === 'alice' && Hash.equals(a.block, h('new')));
  assertEquals(aliceActions.length, 0);
});

// -- Push priority computation -------------------------------------

Deno.test('push priority: amount / responseIndex * deliveryRate / size', () => {
  const { routingProvider, gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routingProvider.setSize(h('new'), 200);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('trigger'), V, 100, 'alice');

  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 50 }]);
  routing.blockReceived(h('new'), null);

  // priority = (amount=100 / responseIndex=1) * deliveryRate(0.5) / size(200)
  // = 100 * 0.5 / 200 = 0.25
  assertEquals(actions.length, 1);
  assertAlmostEquals(actions[0].priority, 0.25, 0.01);
});

Deno.test('push priority: response index starts at 1', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('trigger'), V, 100, 'alice');

  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V, value: 50 }]);
  routing.blockReceived(h('B1'), null);

  assert(actions.length >= 1);
  const p1 = actions[0].priority;

  // Report push and send another block
  routing.reportPush(h('B1'), 'alice', V);

  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V, value: 50 }]);
  routing.blockReceived(h('B2'), null);

  const b2Actions = actions.filter((a) => Hash.equals(a.block, h('B2')));
  assert(b2Actions.length >= 1);
  assertAlmostEquals(b2Actions[0].priority, p1 / 2, 0.01);
});

Deno.test('push priority: response index is per-verifier per-peer', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V1 = vk('game');
  const V2 = vk('pay');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('t1'), V1, 100, 'alice');
  establishClaimHistory(gossip, routing, gossipProvider, h('t2'), V2, 100, 'alice');

  // Push B1 (V1) and report
  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V1, value: 50 }]);
  routing.blockReceived(h('B1'), null);
  routing.reportPush(h('B1'), 'alice', V1);

  // Push B2 (V2) -- response index for V2 is still at 0
  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V2, value: 50 }]);
  routing.blockReceived(h('B2'), null);

  const b1Actions = actions.filter((a) => Hash.equals(a.block, h('B1')));
  const b2Actions = actions.filter((a) => Hash.equals(a.block, h('B2')));
  assert(b1Actions.length >= 1);
  assert(b2Actions.length >= 1);
  assertAlmostEquals(b1Actions[0].priority, b2Actions[0].priority, 0.01);
});

Deno.test('push priority: block size inversely affects priority', () => {
  const { routingProvider, gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('trigger'), V, 100, 'alice');

  routingProvider.setSize(h('small'), 50);
  routingProvider.setSize(h('large'), 500);
  gossipProvider.addBlock(h('small'), [{ index: 0, verifierKey: V, value: 10 }]);
  gossipProvider.addBlock(h('large'), [{ index: 0, verifierKey: V, value: 10 }]);

  routing.blockReceived(h('small'), null);
  routing.blockReceived(h('large'), null);

  const smallAction = actions.find((a) => Hash.equals(a.block, h('small')));
  const largeAction = actions.find((a) => Hash.equals(a.block, h('large')));
  assert(smallAction !== undefined);
  assert(largeAction !== undefined);
  assertGreater(smallAction!.priority, largeAction!.priority);
});

// -- Delivery matrix -----------------------------------------------

Deno.test('delivery matrix: default rate is 0.5 (Beta(1,1) prior)', () => {
  const { routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  assertAlmostEquals(routing.getFirstDeliveryRate(null, 'alice'), 0.5);
});

Deno.test('delivery matrix: novel delivery increments alpha', () => {
  const { gossipProvider, routing } = setup();
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  routing.blockReceived(h('B'), null);
  routing.reportDelivery(h('B'), 'alice', true);

  assertAlmostEquals(routing.getFirstDeliveryRate(null, 'alice'), 2 / 3, 0.01);
});

Deno.test('delivery matrix: redundant delivery increments beta', () => {
  const { gossipProvider, routing } = setup();
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  routing.blockReceived(h('B'), null);
  routing.reportDelivery(h('B'), 'alice', false);

  assertAlmostEquals(routing.getFirstDeliveryRate(null, 'alice'), 1 / 3, 0.01);
});

Deno.test('delivery matrix: decay preserves ratio, reduces confidence', () => {
  const { gossipProvider, routing } = setup({ matrixDecayFactor: 0.5 });
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  routing.blockReceived(h('B'), null);
  routing.reportDelivery(h('B'), 'alice', true);
  routing.reportDelivery(h('B'), 'alice', true);
  routing.reportDelivery(h('B'), 'alice', true);
  routing.reportDelivery(h('B'), 'alice', false);

  const rateBefore = routing.getFirstDeliveryRate(null, 'alice');
  routing.decayMatrices();
  const rateAfter = routing.getFirstDeliveryRate(null, 'alice');

  assertAlmostEquals(rateBefore, rateAfter, 0.01);
});

// -- Reciprocity & bandwidth ----------------------------------------

Deno.test('reciprocity: new peer starts at 1 (neutral)', () => {
  const { routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  assertEquals(routing.getReciprocity('alice'), 1);
});

Deno.test('bandwidth: neutral peer gets base + half bonus', () => {
  const { routing } = setup({ baseRate: 100, bonusRate: 200 });
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  assertAlmostEquals(routing.getBandwidthBudget('alice'), 200, 1);
});

Deno.test('bandwidth: freeloader gets near base rate', () => {
  const { gossipProvider, routing } = setup({ baseRate: 100, bonusRate: 200 });
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  routing.blockReceived(h('B'), null);
  routing.reportPush(h('B'), 'alice');

  assertLess(routing.getBandwidthBudget('alice'), 160);
  assertGreater(routing.getBandwidthBudget('alice'), 100);
});

// -- Gossip quality -------------------------------------------------

Deno.test('gossip quality: increases with novel blocks from peer', () => {
  const { gossipProvider, routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  assertEquals(routing.getGossipQuality('alice'), 0);

  gossipProvider.addBlock(h('B1'), []);
  gossipProvider.addBlock(h('B2'), []);
  routing.blockReceived(h('B1'), 'alice');
  routing.blockReceived(h('B2'), 'alice');

  assertGreater(routing.getGossipQuality('alice'), 0);
});

// -- Fetch ----------------------------------------------------------

Deno.test('fetch: prefers peer with awareness', () => {
  const { routing } = setup();
  const aware = new TestAwareness();
  aware.add(h('target'));

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', aware);

  assertEquals(routing.bestPeerForFetch(h('target')), 'bob');
});

Deno.test('fetch: falls back to most-connected peer', () => {
  const { gossipProvider, routing } = setup();
  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', new TestAwareness());

  gossipProvider.addBlock(h('b1'), []);
  gossipProvider.addBlock(h('b2'), []);
  gossipProvider.addBlock(h('b3'), []);
  routing.blockReceived(h('b1'), 'bob');
  routing.blockReceived(h('b2'), 'bob');
  routing.blockReceived(h('b3'), 'bob');

  assertEquals(routing.bestPeerForFetch(h('unknown')), 'bob');
});

Deno.test('fetch: undefined when no peers', () => {
  const { routing } = setup();
  assertEquals(routing.bestPeerForFetch(h('target')), undefined);
});

// -- Integration: claim history routing flow --------------------

Deno.test('integration: claim history routes V-output block toward claimer peer', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', new TestAwareness());

  // Alice sends us a claiming block for V
  establishClaimHistory(gossip, routing, gossipProvider, h('alice_claim'), V, 10, 'alice');

  // Bob sends us a V-output block
  gossipProvider.addBlock(h('bob_request'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('bob_request'), 'bob');

  // Bob's V-output block should be pushed to alice (claim history match)
  const toAlice = actions.filter((a) =>
    a.peer === 'alice' && Hash.equals(a.block, h('bob_request'))
  );
  assert(toAlice.length >= 1, 'bob_request should be pushed to alice via claim history');
});

Deno.test('integration: claim history count reflects resolved claims', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  establishClaimHistory(gossip, routing, gossipProvider, h('claim1'), V, 10, 'alice');
  establishClaimHistory(gossip, routing, gossipProvider, h('claim2'), V, 20, 'alice');

  assertEquals(gossip.getClaimHistoryCount(V), 2);
});
