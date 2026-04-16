import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  BlockOutput,
  GossipModule,
  GossipProvider,
  SendAction,
  UnclaimedOutput,
  VerifierKey,
} from '../src/node/GossipModule.ts';
import { verifierKey as computeVk } from '../src/node/UtxoIndex.ts';

// --- Test Helpers ---

const h = (name: string): Hash => Hash.digest(name);

function vk(label: string): VerifierKey {
  return computeVk(Hash.digest(`contract:${label}`), new TextEncoder().encode(label));
}

/** Two verifiers sharing the same contract but different params. */
function vkWithParams(contractLabel: string, params: string): VerifierKey {
  return computeVk(Hash.digest(`contract:${contractLabel}`), new TextEncoder().encode(params));
}

// --- Test Provider ---

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

function setup(config?: { maxEntriesPerVerifier?: number; maxEntriesPerContract?: number }) {
  const provider = new TestGossipProvider();
  const module = new GossipModule(provider, config);
  const actions: SendAction[] = [];
  module.onSendAction((a) => actions.push(a));
  return { provider, module, actions };
}

// --- Tests ---

// == Rule 1: notifyClaimResolved ==

Deno.test('Rule 1: notifyClaimResolved emits send action with trigger=claimedBlock', () => {
  const { module, actions } = setup();
  const claimant = h('claimant');
  const claimed = h('claimed');
  const V = vk('game');

  module.notifyClaimResolved(claimant, V, 100, claimed);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].block, claimant);
  assertEquals(actions[0].trigger, claimed);
  assertEquals(actions[0].verifier, V);
  assertEquals(actions[0].amount, 100);
});

Deno.test('Rule 1: multiple claim resolutions emit separate actions', () => {
  const { module, actions } = setup();
  const claimant = h('claimant');
  const claimed1 = h('claimed1');
  const claimed2 = h('claimed2');
  const V1 = vk('game');
  const V2 = vk('data');

  module.notifyClaimResolved(claimant, V1, 50, claimed1);
  module.notifyClaimResolved(claimant, V2, 30, claimed2);

  assertEquals(actions.length, 2);
  assertEquals(actions[0].trigger, claimed1);
  assertEquals(actions[1].trigger, claimed2);
});

// == Rule 2: blockReceived ==

Deno.test('Rule 2: block with V output emits action toward V claim history', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');

  // Establish claim history for V
  module.notifyClaimResolved(h('claimer'), V, 100, h('source'));
  actions.length = 0;

  // New block with V output
  const block = h('new-block');
  provider.addBlock(block, [{ index: 0, verifierKey: V, value: 50 }]);
  module.blockReceived(block);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].block, block);
  assertEquals(actions[0].trigger, h('claimer'));
  assertEquals(actions[0].verifier, V);
  assertEquals(actions[0].amount, 100);
});

Deno.test('Rule 2: no claim history for V -> no actions for outputs', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');

  const block = h('block');
  provider.addBlock(block, [{ index: 0, verifierKey: V, value: 50 }]);
  module.blockReceived(block);

  assertEquals(actions.length, 0);
});

Deno.test('Rule 2: multiple claim history entries -> action per entry', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');

  module.notifyClaimResolved(h('claimer1'), V, 100, h('src1'));
  module.notifyClaimResolved(h('claimer2'), V, 50, h('src2'));
  actions.length = 0;

  const block = h('new-block');
  provider.addBlock(block, [{ index: 0, verifierKey: V, value: 30 }]);
  module.blockReceived(block);

  assertEquals(actions.length, 2);
  assertEquals(actions[0].trigger, h('claimer1'));
  assertEquals(actions[1].trigger, h('claimer2'));
});

Deno.test('Rule 2: blockReceived is idempotent', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');

  module.notifyClaimResolved(h('claimer'), V, 100, h('src'));
  actions.length = 0;

  const block = h('block');
  provider.addBlock(block, [{ index: 0, verifierKey: V, value: 50 }]);
  module.blockReceived(block);
  module.blockReceived(block); // duplicate

  assertEquals(actions.length, 1);
});

// == Claim History Population ==

Deno.test('claim history: notifyClaimResolved adds entries', () => {
  const { module } = setup();
  const V = vk('game');

  assertEquals(module.getClaimHistoryCount(V), 0);

  module.notifyClaimResolved(h('claimer1'), V, 100, h('src1'));
  assertEquals(module.getClaimHistoryCount(V), 1);

  module.notifyClaimResolved(h('claimer2'), V, 50, h('src2'));
  assertEquals(module.getClaimHistoryCount(V), 2);
});

Deno.test('claim history: multiple verifiers tracked independently', () => {
  const { module } = setup();
  const V1 = vk('game');
  const V2 = vk('data');

  module.notifyClaimResolved(h('claimer1'), V1, 100, h('src1'));
  module.notifyClaimResolved(h('claimer2'), V2, 50, h('src2'));

  assertEquals(module.getClaimHistoryCount(V1), 1);
  assertEquals(module.getClaimHistoryCount(V2), 1);
  assertEquals(module.totalClaimHistoryCount, 2);
});

// == Contract-Level Fallback ==

Deno.test('fallback: falls back to contract-level when specific verifier is empty', () => {
  const { provider, module, actions } = setup();

  // Claim with params "A"
  const vA = vkWithParams('game', 'A');
  module.notifyClaimResolved(h('claimer'), vA, 100, h('src'));
  actions.length = 0;

  // Block with params "B" -- no specific history, but same contract
  const vB = vkWithParams('game', 'B');
  const block = h('block');
  provider.addBlock(block, [{ index: 0, verifierKey: vB, value: 50 }]);
  module.blockReceived(block);

  // Should match via contract fallback
  assertEquals(actions.length, 1);
  assertEquals(actions[0].trigger, h('claimer'));
});

Deno.test('fallback: prefers specific verifier over contract fallback', () => {
  const { provider, module, actions } = setup();

  const vA = vkWithParams('game', 'A');
  const vB = vkWithParams('game', 'B');

  // Both verifiers have claim history
  module.notifyClaimResolved(h('claimer-a'), vA, 100, h('src-a'));
  module.notifyClaimResolved(h('claimer-b'), vB, 50, h('src-b'));
  actions.length = 0;

  // Block with params "A" -- should match specific, not fallback
  const block = h('block');
  provider.addBlock(block, [{ index: 0, verifierKey: vA, value: 30 }]);
  module.blockReceived(block);

  // Should only get claimer-a (specific match)
  assertEquals(actions.length, 1);
  assertEquals(actions[0].trigger, h('claimer-a'));
});

Deno.test('fallback: different contracts do not cross-match', () => {
  const { provider, module, actions } = setup();

  module.notifyClaimResolved(h('claimer'), vk('game'), 100, h('src'));
  actions.length = 0;

  // Block with different contract
  const block = h('block');
  provider.addBlock(block, [{ index: 0, verifierKey: vk('data'), value: 50 }]);
  module.blockReceived(block);

  assertEquals(actions.length, 0);
});

// == Backfill ==

Deno.test('backfill: new claim history entry routes existing unclaimed outputs', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');

  // Set up unclaimed outputs for V
  const existingBlock = h('existing');
  provider.setUnclaimed(V, [
    { blockHash: existingBlock, verifierKey: V, value: 80 },
  ]);

  // Resolve a claim -- should trigger backfill
  module.notifyClaimResolved(h('claimer'), V, 100, h('src'));

  // Rule 1 action + backfill action
  assertEquals(actions.length, 2);
  assertEquals(actions[0].block, h('claimer'));
  assertEquals(actions[0].trigger, h('src'));
  assertEquals(actions[1].block, existingBlock);
  assertEquals(actions[1].trigger, h('claimer'));
  assertEquals(actions[1].verifier, V);
});

Deno.test('backfill: empty UTXO index -> no backfill actions', () => {
  const { module, actions } = setup();
  const V = vk('game');

  module.notifyClaimResolved(h('claimer'), V, 100, h('src'));

  assertEquals(actions.length, 1); // only Rule 1 action
});

Deno.test('backfill: skips self-referential entries', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');
  const claimer = h('claimer');

  // The claimer's own block is in the UTXO index
  provider.setUnclaimed(V, [
    { blockHash: claimer, verifierKey: V, value: 80 },
    { blockHash: h('other'), verifierKey: V, value: 60 },
  ]);

  module.notifyClaimResolved(claimer, V, 100, h('src'));

  // Rule 1 + backfill for 'other' only (not self)
  assertEquals(actions.length, 2);
  assertEquals(actions[1].block, h('other'));
});

// == Pruning ==

Deno.test('pruning: entries within limit are not pruned', () => {
  const { module } = setup({ maxEntriesPerVerifier: 5 });
  const V = vk('game');

  for (let i = 0; i < 5; i++) {
    module.notifyClaimResolved(h(`claimer-${i}`), V, 10, h(`src-${i}`));
  }

  assertEquals(module.getClaimHistoryCount(V), 5);
});

Deno.test('pruning: excess entries pruned to max size', () => {
  const { module } = setup({ maxEntriesPerVerifier: 3 });
  const V = vk('game');

  for (let i = 0; i < 10; i++) {
    module.notifyClaimResolved(h(`claimer-${i}`), V, 10, h(`src-${i}`));
  }

  assertEquals(module.getClaimHistoryCount(V), 3);
});

Deno.test('pruning: recent high-value entries survive over old low-value', () => {
  const { module } = setup({ maxEntriesPerVerifier: 2 });
  const V = vk('game');

  // Old low-value entry
  module.notifyClaimResolved(h('old-low'), V, 1, h('src1'));
  // Recent high-value entries
  module.notifyClaimResolved(h('recent-high1'), V, 100, h('src2'));
  module.notifyClaimResolved(h('recent-high2'), V, 100, h('src3'));

  const entries = module.getClaimHistoryDirect(V);
  assertEquals(entries.length, 2);
  const blocks = entries.map((e) => e.block.toPrimitive());
  assertEquals(blocks.includes(h('old-low').toPrimitive()), false);
});

// == Ordering ==

Deno.test('ordering: notifyClaimResolved before blockReceived populates history', () => {
  const { provider, module, actions } = setup();
  const V = vk('game');

  // Simulate Coordinator -> Routing ordering:
  // 1. Claim resolves (populates history)
  module.notifyClaimResolved(h('claimer'), V, 100, h('src'));
  actions.length = 0;

  // 2. Block arrives with V output (matches against history)
  const block = h('block');
  provider.addBlock(block, [{ index: 0, verifierKey: V, value: 50 }]);
  module.blockReceived(block);

  assertEquals(actions.length, 1);
  assertEquals(actions[0].block, block);
  assertEquals(actions[0].trigger, h('claimer'));
});

// == Combined Scenarios ==

Deno.test('combined: multiple outputs on one block match different histories', () => {
  const { provider, module, actions } = setup();
  const V1 = vk('game');
  const V2 = vk('data');

  module.notifyClaimResolved(h('game-claimer'), V1, 100, h('gs'));
  module.notifyClaimResolved(h('data-claimer'), V2, 50, h('ds'));
  actions.length = 0;

  const block = h('multi-output');
  provider.addBlock(block, [
    { index: 0, verifierKey: V1, value: 30 },
    { index: 1, verifierKey: V2, value: 20 },
  ]);
  module.blockReceived(block);

  assertEquals(actions.length, 2);
  assertEquals(actions[0].trigger, h('game-claimer'));
  assertEquals(actions[1].trigger, h('data-claimer'));
});
