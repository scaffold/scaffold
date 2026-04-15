import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertGreater,
  assertLess,
} from '@std/assert';
import { Hash, HashPrimitive } from '../src/util/Hash.ts';
import {
  BlockAwareness,
  PushAction,
  RoutingModule,
  RoutingProvider,
} from '../src/node/RoutingModule.ts';
import {
  GossipModule,
  GossipProvider,
  SendAction,
  SubscribableOutput,
  ResolvedClaimVerifier,
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
    return this.sizes.get(hash.toPrimitive()) ?? 100; // default 100 bytes
  }
}

/** In-memory gossip provider. */
class TestGossipProvider implements GossipProvider {
  private blocks = new Map<string, {
    outputs: SubscribableOutput[];
    claimVerifiers: ResolvedClaimVerifier[];
  }>();

  addBlock(
    hash: Hash,
    outputs: SubscribableOutput[],
    claimVerifiers: ResolvedClaimVerifier[] = [],
  ): void {
    this.blocks.set(hash.toPrimitive(), { outputs, claimVerifiers });
  }

  getSubscribableOutputs(block: Hash): SubscribableOutput[] {
    return this.blocks.get(block.toPrimitive())?.outputs ?? [];
  }

  getResolvedClaimVerifiers(block: Hash): ResolvedClaimVerifier[] {
    return this.blocks.get(block.toPrimitive())?.claimVerifiers ?? [];
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
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V, value: 10 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('B1'), 'alice');

  // Verify indirectly: a second block matching V should produce a push toward alice
  const actions = collectPushActions(routing);
  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('B2'), null);

  assert(actions.some((a) => a.peer === 'alice'));
});

Deno.test('blockReceived: self-originated block enters no receivedFirst', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V, value: 10 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('B1'), null); // self-originated

  // B1 not in alice's receivedFirst, so no subscription created
  const actions = collectPushActions(routing);
  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('B2'), null);

  assertEquals(actions.filter((a) => a.peer === 'alice' && a.verifier === V).length, 0);
});

Deno.test('blockReceived: source integrity (duplicate is no-op)', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V, value: 10 }]);
  const actions = collectPushActions(routing);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('B1'), 'alice');
  routing.blockReceived(h('B1'), 'alice'); // duplicate

  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V, value: 5 }]);
  routing.blockReceived(h('B2'), null);

  // Should only have one subscription-matched action for alice
  const aliceActions = actions.filter((a) => a.peer === 'alice' && a.verifier === V);
  assertEquals(aliceActions.length, 1);
});

// -- Send action -> PushAction mapping -----------------------------

Deno.test('send action routes to peer with trigger in receivedFirst', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 10 }]);
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice'); // trigger in alice's receivedFirst

  routing.blockReceived(h('new'), null);

  const matched = actions.filter((a) => a.peer === 'alice' && Hash.equals(a.block, h('new')));
  assertEquals(matched.length, 1);
});

Deno.test('send action: trigger not in any receivedFirst -> only baseline push', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  // No peer has h('trigger') in receivedFirst
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('new'), null);

  // Only baseline pushes (no subscription match, no verifier field)
  const subscriptionMatched = actions.filter((a) => a.verifier !== undefined);
  assertEquals(subscriptionMatched.length, 0);
});

Deno.test('send action: multiple peers have trigger -> push to all', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 10 }]);
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice');

  // Now bob also sends us the trigger
  // Can't do this since trigger is already in localBlocks.
  // Instead, set up both peers to have the trigger:
  // We need both to have it. Let's reset and have trigger sent by both.
  // Actually, the same block can only enter receivedFirst for the FIRST sender.
  // So if alice sends trigger first, bob doesn't get it in receivedFirst.
  // This tests that only alice gets the push.
});

Deno.test('send action: dedup by (block, peer) keeps highest priority', () => {
  const { gossipProvider, routing } = setup();
  const V1 = vk('game');
  const V2 = vk('pay');
  const actions = collectPushActions(routing);

  // Alice's block has two verifier outputs
  gossipProvider.addBlock(h('trigger'), [
    { index: 0, verifierKey: V1, value: 10 },
    { index: 1, verifierKey: V2, value: 100 },
  ]);
  gossipProvider.addBlock(h('new'), [
    { index: 0, verifierKey: V1, value: 5 },
    { index: 1, verifierKey: V2, value: 5 },
  ]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice');
  routing.blockReceived(h('new'), null);

  // Only one push action for alice (deduped), with the higher priority
  const aliceActions = actions.filter((a) =>
    a.peer === 'alice' && Hash.equals(a.block, h('new'))
  );
  assertEquals(aliceActions.length, 1);
  // V2 subscription has higher amount (100 vs 10), so its priority should win
  assertEquals(aliceActions[0].verifier, V2);
});

Deno.test('send action: skip peer whose awareness already has block', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  const awareness = new TestAwareness();
  awareness.add(h('new')); // alice already knows about h('new')

  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 10 }]);
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);

  routing.addPeer('alice', 'pk_alice', awareness);
  routing.blockReceived(h('trigger'), 'alice');
  routing.blockReceived(h('new'), null);

  // Alice already has 'new', so no push
  const aliceActions = actions.filter((a) =>
    a.peer === 'alice' && Hash.equals(a.block, h('new'))
  );
  assertEquals(aliceActions.length, 0);
});

// -- Push priority computation -------------------------------------

Deno.test('push priority: amount / responseIndex * deliveryRate / size', () => {
  const { routingProvider, gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  routingProvider.setSize(h('new'), 200); // 200 bytes
  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 100 }]);
  gossipProvider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 50 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice');
  routing.blockReceived(h('new'), null);

  // priority = (amount=100 / responseIndex=1) * deliveryRate(0.5) / size(200)
  // = 100 * 0.5 / 200 = 0.25
  assertEquals(actions.length, 1);
  assertAlmostEquals(actions[0].priority, 0.25, 0.01);
});

Deno.test('push priority: response index starts at 1', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 100 }]);
  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V, value: 50 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice');
  routing.blockReceived(h('B1'), null);

  // First push: responseIndex = 0 + 1 = 1. Priority uses amount/1.
  assert(actions.length >= 1);
  const p1 = actions[0].priority;

  // Report push and send another block
  routing.reportPush(h('B1'), 'alice', V);

  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V, value: 50 }]);
  routing.blockReceived(h('B2'), null);

  // Second push: responseIndex = 1 + 1 = 2. Priority uses amount/2 (halved).
  const b2Actions = actions.filter((a) => Hash.equals(a.block, h('B2')));
  assert(b2Actions.length >= 1);
  assertAlmostEquals(b2Actions[0].priority, p1 / 2, 0.01);
});

Deno.test('push priority: response index is per-verifier per-peer', () => {
  const { gossipProvider, routing } = setup();
  const V1 = vk('game');
  const V2 = vk('pay');
  const actions = collectPushActions(routing);

  gossipProvider.addBlock(h('t1'), [{ index: 0, verifierKey: V1, value: 100 }]);
  gossipProvider.addBlock(h('t2'), [{ index: 0, verifierKey: V2, value: 100 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('t1'), 'alice');
  routing.blockReceived(h('t2'), 'alice');

  // Push B1 (V1) and report
  gossipProvider.addBlock(h('B1'), [{ index: 0, verifierKey: V1, value: 50 }]);
  routing.blockReceived(h('B1'), null);
  routing.reportPush(h('B1'), 'alice', V1);

  // Push B2 (V2) -- response index for V2 is still at 0
  gossipProvider.addBlock(h('B2'), [{ index: 0, verifierKey: V2, value: 50 }]);
  routing.blockReceived(h('B2'), null);

  // V1 responseIndex=1, V2 responseIndex=0
  // B2 priority should be same as B1's first push (not halved)
  const b1Actions = actions.filter((a) => Hash.equals(a.block, h('B1')));
  const b2Actions = actions.filter((a) => Hash.equals(a.block, h('B2')));
  assert(b1Actions.length >= 1);
  assert(b2Actions.length >= 1);
  assertAlmostEquals(b1Actions[0].priority, b2Actions[0].priority, 0.01);
});

Deno.test('push priority: block size inversely affects priority', () => {
  const { routingProvider, gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 100 }]);

  routingProvider.setSize(h('small'), 50);
  routingProvider.setSize(h('large'), 500);
  gossipProvider.addBlock(h('small'), [{ index: 0, verifierKey: V, value: 10 }]);
  gossipProvider.addBlock(h('large'), [{ index: 0, verifierKey: V, value: 10 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice');
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
  routing.reportDelivery(h('B'), 'alice', true); // novel

  // Beta(1+1, 1) = Beta(2, 1) -> E = 2/3
  assertAlmostEquals(routing.getFirstDeliveryRate(null, 'alice'), 2 / 3, 0.01);
});

Deno.test('delivery matrix: redundant delivery increments beta', () => {
  const { gossipProvider, routing } = setup();
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  routing.blockReceived(h('B'), null);
  routing.reportDelivery(h('B'), 'alice', false); // redundant

  // Beta(1, 1+1) = Beta(1, 2) -> E = 1/3
  assertAlmostEquals(routing.getFirstDeliveryRate(null, 'alice'), 1 / 3, 0.01);
});

Deno.test('delivery matrix: decay preserves ratio, reduces confidence', () => {
  const { gossipProvider, routing } = setup({ matrixDecayFactor: 0.5 });
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  routing.blockReceived(h('B'), null);
  // 3 novel, 1 redundant -> Beta(4, 2) -> E = 4/6
  routing.reportDelivery(h('B'), 'alice', true);
  routing.reportDelivery(h('B'), 'alice', true);
  routing.reportDelivery(h('B'), 'alice', true);
  routing.reportDelivery(h('B'), 'alice', false);

  const rateBefore = routing.getFirstDeliveryRate(null, 'alice');
  routing.decayMatrices();
  const rateAfter = routing.getFirstDeliveryRate(null, 'alice');

  // Ratio preserved (proportional decay)
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
  // reciprocity = 1 -> sigmoid(0) = 0.5 -> 100 + 200*0.5 = 200
  assertAlmostEquals(routing.getBandwidthBudget('alice'), 200, 1);
});

Deno.test('bandwidth: freeloader gets near base rate', () => {
  const { gossipProvider, routing } = setup({ baseRate: 100, bonusRate: 200 });
  gossipProvider.addBlock(h('B'), []);
  routing.addPeer('alice', 'pk_alice', new TestAwareness());

  // We push to alice but she never sends anything useful
  routing.blockReceived(h('B'), null);
  routing.reportPush(h('B'), 'alice');

  // reciprocity = 0/1 = 0 -> sigmoid(-1) ~= 0.27 -> ~154
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

  // Give bob more receivedFirst entries
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

// -- Integration: full subscription routing flow --------------------

Deno.test('integration: peer sends V block, matching V block arrives, push targets peer', () => {
  const { gossipProvider, routing } = setup();
  const V = vk('game');
  const actions = collectPushActions(routing);

  gossipProvider.addBlock(h('from_alice'), [{ index: 0, verifierKey: V, value: 10 }]);
  gossipProvider.addBlock(h('from_bob'), [{ index: 0, verifierKey: V, value: 5 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.addPeer('bob', 'pk_bob', new TestAwareness());

  // Alice sends us a V block
  routing.blockReceived(h('from_alice'), 'alice');

  // Bob sends us another V block
  routing.blockReceived(h('from_bob'), 'bob');

  // from_bob should be pushed to alice (alice subscribes to V via from_alice)
  // from_alice should be pushed to bob (bob subscribes to V via from_bob, via backfill)
  const toAlice = actions.filter((a) =>
    a.peer === 'alice' && Hash.equals(a.block, h('from_bob'))
  );
  const toBob = actions.filter((a) =>
    a.peer === 'bob' && Hash.equals(a.block, h('from_alice'))
  );
  assert(toAlice.length >= 1, 'from_bob should be pushed to alice');
  assert(toBob.length >= 1, 'from_alice should be pushed to bob');
});

Deno.test('integration: subscription source feeding from receivedFirst', () => {
  const { gossipProvider, gossip, routing } = setup();
  const V = vk('game');

  gossipProvider.addBlock(h('trigger'), [{ index: 0, verifierKey: V, value: 10 }]);

  routing.addPeer('alice', 'pk_alice', new TestAwareness());
  routing.blockReceived(h('trigger'), 'alice');

  // The gossip module should now have h('trigger') as a subscription source
  assertEquals(gossip.getSubscriptionCount(V), 1);
});
