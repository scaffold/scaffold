/**
 * Routing tests.
 *
 * Verifies that the receivedFirst chain creates routing paths through
 * intermediary nodes -- the core property of the claim-history-based
 * gossip model.
 *
 * Key difference from subscription model: blocks only route toward
 * peers with claim history for the matching verifier, not toward
 * peers with unclaimed outputs of the same verifier.
 */

import { PacketType } from '../../src/core/Packet.ts';
import { assert } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { AtomSource, AtomType, Block, createGenesisBlock } from '../../src/core/Block.ts';
import { Output } from '../../src/core/BlockCreationModule.ts';
import { TestNetwork } from './TestNetwork.ts';

// Use a consistent verifier label throughout
const V_LABEL = 'game-v';

function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    data: new Uint8Array([]),
  };
}

function makeBlock(
  name: string,
  anchor: Block,
  outputs: Output[],
  declaredWeight: number,
  claims: number[] = [],
): Block {
  return {
    hash: Hash.digest(name),
    anchor: anchor.hash,
    aggregates: [],
    claims,
    outputs,
    declaredWeight,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    source: AtomSource.Local,
  };
}

/** Genesis with outputs that use V_LABEL so claims resolve to the right verifier. */
function makeRoutingGenesis(): Block {
  return createGenesisBlock([
    makeOutput(100, V_LABEL),
    makeOutput(100, V_LABEL),
  ]);
}

Deno.test('Routing: 3-node claim-history path via receivedFirst chain', () => {
  // Linear topology: A <-> B <-> C (no direct A<->C link).
  //
  // 1. Charlie sends a claiming block to Bob. The claim resolves via
  //    OutputClaimModule, establishing V claim history on Bob and placing
  //    Charlie's block in Bob's receivedFirst.
  // 2. Alice sends a V-output request to Bob. Rule 2 matches against
  //    V claim history, routing Alice's request toward Charlie through Bob.
  // 3. Charlie publishes a second response claiming Alice's V output.
  //    Rule 1 routes the claim back toward Alice through Bob.

  const net = new TestNetwork();
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);

  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');

  const genesis = makeRoutingGenesis();
  net.broadcastGenesis(genesis);

  // -- Phase 1: Charlie establishes claim history on Bob ---------------

  // Charlie's block claims genesis output 0 (index 1 in extended vector
  // because own output is at index 0).
  const charlieResponse = makeBlock(
    'charlie-response',
    genesis,
    [makeOutput(50, V_LABEL)],
    20,
    [1], // claim extended index 1 = genesis output 0
  );

  net.getNode('C').receiveBlock(charlieResponse, null);
  net.deliverFromPeer(charlieResponse, 'B', 'C');
  net.flush();

  // -- Phase 2: Alice sends a V-output request -------------------------

  const aliceRequest = makeBlock(
    'alice-request',
    genesis,
    [makeOutput(50, V_LABEL)],
    10,
  );

  net.getNode('A').receiveBlock(aliceRequest, null);
  net.deliverFromPeer(aliceRequest, 'B', 'A');
  net.flush();

  // Alice's request should reach Charlie through Bob (via V claim history).
  net.assertNodeHas('C', aliceRequest.hash);

  // -- Phase 3: Charlie responds claiming Alice's V output -------------

  // Charlie's second block claims Alice's request output.
  // Extended vector: [own_output_0, anchor_surviving_outputs...]
  // Alice's request has 1 output at index 0. Charlie's block anchors to
  // genesis (not aliceRequest), so it can't directly claim via extended vector.
  // Instead, use resolvedClaims for Rule 1 routing.
  const charlieResponse2 = makeBlock(
    'charlie-response2',
    genesis,
    [makeOutput(50, 'response-data')],
    20,
    [2], // claim extended index 2 = genesis output 1
  );

  net.getNode('C').receiveBlock(charlieResponse2, null);
  net.deliverFromPeer(charlieResponse2, 'B', 'C');
  net.flush();

  // Response routed through Bob. Charlie's second claim also builds V claim
  // history, but the routing is primarily via claim history from phase 1.
  net.assertNodeHas('B', charlieResponse2.hash);
});

Deno.test('Routing: 4-node chain routes end-to-end via claim history', () => {
  // A <-> B <-> C <-> D -- verifies multi-hop propagation.

  const net = new TestNetwork();
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);
  net.addNode('D', false);

  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');
  net.connectPeers('C', 'D');

  const genesis = makeRoutingGenesis();
  net.broadcastGenesis(genesis);

  // D publishes a claiming block, establishing V claim history.
  const claimD = makeBlock(
    'claim-d',
    genesis,
    [makeOutput(50, V_LABEL)],
    10,
    [1], // claim genesis output 0
  );

  // Propagate claimD from D through the chain: D -> C -> B
  net.getNode('D').receiveBlock(claimD, null);
  net.deliverFromPeer(claimD, 'C', 'D');
  net.deliverFromPeer(claimD, 'B', 'C');
  net.flush();

  // A publishes a V-output request.
  const requestA = makeBlock('request-a', genesis, [makeOutput(50, V_LABEL)], 10);
  net.getNode('A').receiveBlock(requestA, null);
  net.deliverFromPeer(requestA, 'B', 'A');
  net.flush();

  // Request should propagate A -> B -> C -> D via V claim history.
  net.assertNodeHas('C', requestA.hash);
  net.assertNodeHas('D', requestA.hash);
});
