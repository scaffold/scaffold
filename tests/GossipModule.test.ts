import { assertEquals, assert } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
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

/** Deterministic verifier key from a label. */
function vk(label: string): VerifierKey {
  return Hash.digest(`contract:${label}`).toHex() + ':' +
    Array.from(new TextEncoder().encode(label))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
}

/** In-memory test provider for the gossip module. */
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

function setup() {
  const provider = new TestGossipProvider();
  const module = new GossipModule(provider);
  return { provider, module };
}

function collectActions(module: GossipModule): SendAction[] {
  const actions: SendAction[] = [];
  module.onSendAction((a) => actions.push(a));
  return actions;
}

// -- Subscription index tests ------------------------------------

Deno.test('addSubscriptionSource: adds non-self-claimed outputs to index', () => {
  const { provider, module } = setup();
  const V = vk('game');
  provider.addBlock(h('A'), [
    { index: 0, verifierKey: V, value: 10 },
    { index: 1, verifierKey: vk('other'), value: 5 },
  ]);

  module.addSubscriptionSource(h('A'));

  assertEquals(module.getSubscriptionCount(V), 1);
  assertEquals(module.getSubscriptionCount(vk('other')), 1);
  assertEquals(module.totalSubscriptionCount, 2);
});

Deno.test('addSubscriptionSource: self-claimed outputs excluded by provider', () => {
  // The provider is responsible for filtering self-claims.
  // If the provider returns only non-self-claimed outputs, they all enter the index.
  const { provider, module } = setup();
  const V = vk('game');
  // Provider returns only 1 output (output 1); output 0 was self-claimed and filtered
  provider.addBlock(h('A'), [
    { index: 1, verifierKey: V, value: 10 },
  ]);

  module.addSubscriptionSource(h('A'));
  assertEquals(module.getSubscriptionCount(V), 1);
});

Deno.test('addSubscriptionSource: idempotent', () => {
  const { provider, module } = setup();
  const V = vk('game');
  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);

  module.addSubscriptionSource(h('A'));
  module.addSubscriptionSource(h('A'));

  assertEquals(module.getSubscriptionCount(V), 1);
});

Deno.test('addSubscriptionSource: exact verifier matching', () => {
  const { provider, module } = setup();
  const V1 = vk('game:config1');
  const V2 = vk('game:config2');
  provider.addBlock(h('A'), [{ index: 0, verifierKey: V1, value: 10 }]);
  provider.addBlock(h('B'), [{ index: 0, verifierKey: V2, value: 10 }]);

  module.addSubscriptionSource(h('A'));
  module.addSubscriptionSource(h('B'));

  assertEquals(module.getSubscriptionCount(V1), 1);
  assertEquals(module.getSubscriptionCount(V2), 1);
});

Deno.test('addSubscriptionSource: empty block produces no subscriptions', () => {
  const { provider, module } = setup();
  provider.addBlock(h('A'), []);

  module.addSubscriptionSource(h('A'));
  assertEquals(module.totalSubscriptionCount, 0);
});

// -- New content matching (blockReceived) --------------------------

Deno.test('blockReceived: block with V output triggers send actions to V subscribers', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  provider.addBlock(h('B'), [{ index: 0, verifierKey: V, value: 8 }]);

  module.addSubscriptionSource(h('A'));
  module.blockReceived(h('B'));

  // B has V output, A subscribes to V -> send B toward A
  assertEquals(actions.length, 1);
  assertEquals(Hash.equals(actions[0].block, h('B')), true);
  assertEquals(Hash.equals(actions[0].trigger, h('A')), true);
  assertEquals(actions[0].verifier, V);
  assertEquals(actions[0].amount, 10); // A's subscription value
});

Deno.test('blockReceived: no subscribers -> no send actions', () => {
  const { provider, module } = setup();
  const actions = collectActions(module);

  provider.addBlock(h('B'), [{ index: 0, verifierKey: vk('game'), value: 8 }]);
  module.blockReceived(h('B'));

  assertEquals(actions.length, 0);
});

Deno.test('blockReceived: block matching multiple verifiers -> actions for each', () => {
  const { provider, module } = setup();
  const V1 = vk('game');
  const V2 = vk('pay');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V1, value: 10 }]);
  provider.addBlock(h('B'), [{ index: 0, verifierKey: V2, value: 20 }]);
  provider.addBlock(h('C'), [
    { index: 0, verifierKey: V1, value: 5 },
    { index: 1, verifierKey: V2, value: 5 },
  ]);

  module.addSubscriptionSource(h('A'));
  module.addSubscriptionSource(h('B'));
  module.blockReceived(h('C'));

  // C matches V1 (trigger A) and V2 (trigger B)
  assertEquals(actions.length, 2);
  const triggers = actions.map((a) => a.trigger.toPrimitive()).sort();
  assert(triggers.includes(h('A').toPrimitive()));
  assert(triggers.includes(h('B').toPrimitive()));
});

Deno.test('blockReceived: idempotent (duplicate calls ignored)', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  provider.addBlock(h('B'), [{ index: 0, verifierKey: V, value: 8 }]);

  module.addSubscriptionSource(h('A'));
  module.blockReceived(h('B'));
  module.blockReceived(h('B')); // second call

  assertEquals(actions.length, 1); // only one action
});

// -- Claim notifications (blockReceived) ---------------------------

Deno.test('blockReceived: claim notification to V subscribers', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  // B claims a V output (no V outputs of its own)
  provider.addBlock(h('B'), [], [{ verifierKey: V, value: 10 }]);

  module.addSubscriptionSource(h('A'));
  module.blockReceived(h('B'));

  assertEquals(actions.length, 1);
  assertEquals(Hash.equals(actions[0].block, h('B')), true);
  assertEquals(Hash.equals(actions[0].trigger, h('A')), true);
});

Deno.test('blockReceived: claim on non-subscribed verifier -> no actions', () => {
  const { provider, module } = setup();
  const actions = collectActions(module);

  provider.addBlock(h('B'), [], [{ verifierKey: vk('unknown'), value: 10 }]);
  module.blockReceived(h('B'));

  assertEquals(actions.length, 0);
});

// -- Backfill (addSubscriptionSource) ------------------------------

Deno.test('addSubscriptionSource: backfill pushes existing V content to new subscriber', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  provider.addBlock(h('B'), [{ index: 0, verifierKey: V, value: 8 }]);

  module.addSubscriptionSource(h('A'));
  // No actions yet (A is alone)
  assertEquals(actions.length, 0);

  module.addSubscriptionSource(h('B'));
  // Backfill: A pushed toward B, B pushed toward A
  assertEquals(actions.length, 2);

  const blockTriggerPairs = actions.map((a) => [
    a.block.toPrimitive(),
    a.trigger.toPrimitive(),
  ]);
  // A -> B (existing content pushed to new subscriber)
  assert(blockTriggerPairs.some(([b, t]) =>
    b === h('A').toPrimitive() && t === h('B').toPrimitive()
  ));
  // B -> A (new subscriber's content pushed to existing subscriber)
  assert(blockTriggerPairs.some(([b, t]) =>
    b === h('B').toPrimitive() && t === h('A').toPrimitive()
  ));
});

Deno.test('addSubscriptionSource: backfill for new verifier (no existing content) -> empty', () => {
  const { provider, module } = setup();
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: vk('new'), value: 10 }]);
  module.addSubscriptionSource(h('A'));

  assertEquals(actions.length, 0);
});

Deno.test('addSubscriptionSource: backfill is bidirectional with 3 subscribers', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  provider.addBlock(h('B'), [{ index: 0, verifierKey: V, value: 8 }]);
  provider.addBlock(h('C'), [{ index: 0, verifierKey: V, value: 6 }]);

  module.addSubscriptionSource(h('A')); // 0 actions
  module.addSubscriptionSource(h('B')); // 2 actions (A<->B)
  module.addSubscriptionSource(h('C')); // 4 actions (A<->C, B<->C)

  assertEquals(actions.length, 6);
});

// -- Send action fields -------------------------------------------

Deno.test('send action: trigger points to subscription source block', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('sub'), [{ index: 0, verifierKey: V, value: 100 }]);
  provider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 50 }]);

  module.addSubscriptionSource(h('sub'));
  module.blockReceived(h('new'));

  assertEquals(actions.length, 1);
  assertEquals(Hash.equals(actions[0].trigger, h('sub')), true);
});

Deno.test('send action: amount reflects subscription output value', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('sub'), [{ index: 0, verifierKey: V, value: 42 }]);
  provider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 999 }]);

  module.addSubscriptionSource(h('sub'));
  module.blockReceived(h('new'));

  assertEquals(actions[0].amount, 42); // subscription value, not new block's value
});

Deno.test('send action: verifier field is the matched verifierKey', () => {
  const { provider, module } = setup();
  const V = vk('specific-game');
  const actions = collectActions(module);

  provider.addBlock(h('sub'), [{ index: 0, verifierKey: V, value: 10 }]);
  provider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);

  module.addSubscriptionSource(h('sub'));
  module.blockReceived(h('new'));

  assertEquals(actions[0].verifier, V);
});

// -- Subscription lifecycle ----------------------------------------

Deno.test('outputClaimed: removes entry from index', () => {
  const { provider, module } = setup();
  const V = vk('game');

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  module.addSubscriptionSource(h('A'));
  assertEquals(module.getSubscriptionCount(V), 1);

  module.outputClaimed(h('A'), 0);
  assertEquals(module.getSubscriptionCount(V), 0);
});

Deno.test('outputUnclaimed: re-adds entry to index', () => {
  const { provider, module } = setup();
  const V = vk('game');

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  module.addSubscriptionSource(h('A'));
  module.outputClaimed(h('A'), 0);
  assertEquals(module.getSubscriptionCount(V), 0);

  module.outputUnclaimed(h('A'), 0);
  assertEquals(module.getSubscriptionCount(V), 1);
});

Deno.test('outputClaimed: non-existent entry is no-op', () => {
  const { module } = setup();
  // Should not throw
  module.outputClaimed(h('nonexistent'), 0);
});

Deno.test('claim + output to same verifier in one block: both rules fire', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  // B both outputs to V and claims a V output
  provider.addBlock(h('B'), [
    { index: 0, verifierKey: V, value: 8 },
  ], [
    { verifierKey: V, value: 10 },
  ]);

  module.addSubscriptionSource(h('A'));
  module.blockReceived(h('B'));

  // Two send actions: one for the V output match, one for the V claim match
  assertEquals(actions.length, 2);
  // Both trigger A
  assert(actions.every((a) => Hash.equals(a.trigger, h('A'))));
});

Deno.test('aggregation marker migration: claim marker, add new marker', () => {
  const { provider, module } = setup();
  const V_marker_A = vk('agg:A');
  const V_marker_E = vk('agg:E');
  const actions = collectActions(module);

  // Block A has an aggregation marker
  provider.addBlock(h('A'), [{ index: 1, verifierKey: V_marker_A, value: 0 }]);
  // Aggregator E claims A's marker and produces its own
  provider.addBlock(h('E'), [
    { index: 1, verifierKey: V_marker_E, value: 0 },
  ], [
    { verifierKey: V_marker_A, value: 0 },
  ]);

  module.addSubscriptionSource(h('A'));
  assertEquals(module.getSubscriptionCount(V_marker_A), 1);

  module.blockReceived(h('E'));
  // E's claim on A's marker triggers a send action (claim notification)
  assert(actions.some((a) => Hash.equals(a.block, h('E'))));
});

// -- Deferred resolution -------------------------------------------

Deno.test('notifyClaimResolved: emits send actions to V subscribers', () => {
  const { provider, module } = setup();
  const V = vk('game');
  const actions = collectActions(module);

  provider.addBlock(h('A'), [{ index: 0, verifierKey: V, value: 10 }]);
  module.addSubscriptionSource(h('A'));

  module.notifyClaimResolved(h('claimer'), V, 10);

  assertEquals(actions.length, 1);
  assertEquals(Hash.equals(actions[0].block, h('claimer')), true);
  assertEquals(Hash.equals(actions[0].trigger, h('A')), true);
});

Deno.test('notifyClaimResolved: unsubscribed verifier -> empty', () => {
  const { module } = setup();
  const actions = collectActions(module);

  module.notifyClaimResolved(h('claimer'), vk('unknown'), 10);

  assertEquals(actions.length, 0);
});

// -- Edge cases ---------------------------------------------------

Deno.test('blockReceived: unknown block (provider returns empty) -> no actions', () => {
  const { module } = setup();
  const actions = collectActions(module);

  // h('unknown') not added to provider
  module.blockReceived(h('unknown'));
  assertEquals(actions.length, 0);
});

Deno.test('many subscribers to same verifier: O(n) send actions', () => {
  const { provider, module } = setup();
  const V = vk('popular');
  const actions = collectActions(module);

  // 20 subscribers
  for (let i = 0; i < 20; i++) {
    provider.addBlock(h(`sub${i}`), [{ index: 0, verifierKey: V, value: i + 1 }]);
    module.addSubscriptionSource(h(`sub${i}`));
  }

  // Clear backfill actions
  actions.length = 0;

  // New block with V output
  provider.addBlock(h('new'), [{ index: 0, verifierKey: V, value: 5 }]);
  module.blockReceived(h('new'));

  // 20 send actions, one per subscriber
  assertEquals(actions.length, 20);
  // All point to h('new') as block
  assert(actions.every((a) => Hash.equals(a.block, h('new'))));
  // All have different triggers
  const triggers = new Set(actions.map((a) => a.trigger.toPrimitive()));
  assertEquals(triggers.size, 20);
});

Deno.test('multiple outputs to same verifier on one block: separate entries', () => {
  const { provider, module } = setup();
  const V = vk('game');

  // Block A has two outputs to the same verifier
  provider.addBlock(h('A'), [
    { index: 0, verifierKey: V, value: 10 },
    { index: 1, verifierKey: V, value: 20 },
  ]);

  module.addSubscriptionSource(h('A'));
  // Two entries (different output indices)
  assertEquals(module.getSubscriptionCount(V), 2);

  const entries = module.getSubscriptionEntries(V);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].outputIndex, 0);
  assertEquals(entries[1].outputIndex, 1);
});
