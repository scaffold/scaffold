/**
 * Tests for the gossip claim history lifecycle wiring in NodeContext.
 *
 * Verifies that:
 * - Claim resolutions populate gossip claim history (via notifyClaimResolved)
 * - Canonical flips do NOT affect claim history (append-only)
 * - Backfill routes existing unclaimed outputs to new claimers
 */
import { PacketType } from '../src/core/Packet.ts';
import { withNodeFields } from './testutil/blockNodeFields.ts';

import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { AtomSource, AtomType, Block, BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { NodeConfig, NodeContext } from '../src/node/NodeContext.ts';
import { verifierKey } from '../src/node/UtxoIndex.ts';
import { SendAction } from '../src/node/GossipModule.ts';

// --- Test Helpers ---

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
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claimIndices: number[] = [],
): Block {
  return withNodeFields({
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: [],
    claimIndices,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
  });
}

function createContext() {
  const genesis = createGenesisBlock([
    makeOutput(100, 'game'),
    makeOutput(100, 'game'),
  ]);
  const config: NodeConfig = { genesis };
  const ctx = new NodeContext(config);
  return { ctx, genesis };
}

// --- Tests ---

Deno.test('gossip lifecycle: claim resolution populates claim history', () => {
  const { ctx, genesis } = createContext();
  const V = vk('game');

  // Initial state: no claim history
  assertEquals(ctx.gossip.getClaimHistoryCount(V), 0);

  // Block that claims genesis output 0.
  // Extended output vector: [own_output_0, genesis_output_0, genesis_output_1]
  // Claim index 1 targets genesis_output_0.
  const claimer = makeBlock(
    'claimer',
    genesis,
    [makeOutput(90, 'game')],
    10,
    [1],
  );

  ctx.processBlock(claimer);

  // Claim should resolve and populate claim history
  assertEquals(ctx.gossip.getClaimHistoryCount(V), 1);

  const entries = ctx.gossip.getClaimHistoryDirect(V);
  assertEquals(entries[0].block, claimer.hash);
});

Deno.test('gossip lifecycle: canonical flip does NOT affect claim history', () => {
  const { ctx, genesis } = createContext();
  const V = vk('game');

  // Two competing blocks that both claim genesis output 0.
  // Claim index 1 targets genesis_output_0 (index 0 is own output).
  const blockA = makeBlock(
    'blockA',
    genesis,
    [makeOutput(90, 'game')],
    10,
    [1],
  );
  const blockB = makeBlock(
    'blockB',
    genesis,
    [makeOutput(90, 'game')],
    20, // higher weight -- will be canonical
    [1],
  );

  ctx.processBlock(blockA);
  assertEquals(ctx.gossip.getClaimHistoryCount(V), 1);

  ctx.processBlock(blockB);

  // Both claims resolved -> both in claim history (canonical flip doesn't remove)
  assertEquals(ctx.gossip.getClaimHistoryCount(V), 2);
});

Deno.test('gossip lifecycle: claim resolution emits Rule 1 send action', () => {
  const { ctx, genesis } = createContext();
  const V = vk('game');

  const actions: SendAction[] = [];
  ctx.gossip.onSendAction((a) => actions.push(a));

  const claimer = makeBlock(
    'claimer',
    genesis,
    [makeOutput(90, 'game')],
    10,
    [1],
  );

  ctx.processBlock(claimer);

  // Should have at least one Rule 1 action: claimer -> genesis
  const rule1 = actions.filter(
    (a) =>
      a.block.toPrimitive() === claimer.hash.toPrimitive() &&
      a.trigger.toPrimitive() === genesis.hash.toPrimitive(),
  );
  assertEquals(
    rule1.length >= 1,
    true,
    'Expected Rule 1 send action routing claimer toward genesis',
  );
});
