/**
 * Routing tests.
 *
 * Verifies that the receivedFirst chain creates bidirectional routing
 * paths through intermediary nodes -- the core property of the
 * subscription-based gossip model.
 */

import { assert } from '@std/assert';
import { TestNetwork } from './TestNetwork.ts';
import { makeBlock, makeGenesis, makeOutput } from './helpers.ts';

Deno.test('Routing: 3-node bidirectional path via receivedFirst chain', () => {
  // Linear topology: A <-> B <-> C (no direct A<->C link).
  //
  // 1. Alice and Charlie both send V-output blocks to Bob, establishing
  //    mutual V subscriptions and populating receivedFirst on Bob.
  // 2. Backfill cross-delivers: Alice's request reaches Charlie, and
  //    Charlie's interest block reaches Alice -- both through Bob.
  // 3. Charlie publishes a response that claims Alice's V output.
  //    The claim matches V subscriptions on Charlie's and Bob's nodes,
  //    routing the response back through Bob to Alice.

  const net = new TestNetwork();
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);

  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  // -- Phase 1: Establish V subscriptions on Bob ----------------------

  const aliceRequest = makeBlock(
    'alice-request',
    genesis,
    [makeOutput(50, 'request-v')],
    10,
  );
  const charlieInterest = makeBlock(
    'charlie-interest',
    genesis,
    [makeOutput(50, 'request-v')],
    10,
  );

  // Charlie sends V-output block to Bob.
  // Bob creates V subscription (trigger=charlieInterest) with Charlie in receivedFirst.
  net.getNode('C').receiveBlock(charlieInterest, null);
  net.deliverFromPeer(charlieInterest, 'B', 'C');

  // Alice sends V-output block to Bob.
  // Backfill fires: Bob pushes charlieInterest toward Alice and
  // aliceRequest toward Charlie via their receivedFirst entries.
  net.getNode('A').receiveBlock(aliceRequest, null);
  net.deliverFromPeer(aliceRequest, 'B', 'A');
  net.flush();

  // Alice's request reached Charlie through Bob.
  net.assertNodeHas('C', aliceRequest.hash);
  // Charlie's interest block reached Alice through Bob.
  net.assertNodeHas('A', charlieInterest.hash);

  // -- Phase 2: Charlie publishes a response (claims Alice's V output) -

  // The response has its own output (different verifier) and a
  // resolvedClaim referencing Alice's V output. The gossip module
  // matches the claim's verifier against V subscriptions, routing the
  // response back through Bob to Alice.
  const charlieResponse = {
    ...makeBlock('charlie-response', genesis, [makeOutput(50, 'response-data')], 20),
    resolvedClaims: [{
      block: aliceRequest.hash,
      outputIndex: 0,
      value: 50,
    }],
  };

  // Sanity: Alice does not have the response yet.
  net.assertNodeMissing('A', charlieResponse.hash);

  net.submitBlock(charlieResponse, 'C');
  net.flush();

  // Response routed through Bob to Alice.
  net.assertNodeHas('B', charlieResponse.hash);
  net.assertNodeHas('A', charlieResponse.hash);
});

Deno.test('Routing: response with V output routes back without claims', () => {
  // Same topology, but the response carries a V output instead of a
  // resolvedClaim. This exercises the output-matching path in gossip
  // rather than claim-matching.

  const net = new TestNetwork();
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);

  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  const aliceRequest = makeBlock(
    'alice-req2',
    genesis,
    [makeOutput(50, 'verifier-v')],
    10,
  );
  const charlieSubscription = makeBlock(
    'charlie-sub',
    genesis,
    [makeOutput(50, 'verifier-v')],
    10,
  );

  // Bootstrap subscriptions on Bob.
  net.getNode('C').receiveBlock(charlieSubscription, null);
  net.deliverFromPeer(charlieSubscription, 'B', 'C');
  net.getNode('A').receiveBlock(aliceRequest, null);
  net.deliverFromPeer(aliceRequest, 'B', 'A');
  net.flush();

  net.assertNodeHas('C', aliceRequest.hash);
  net.assertNodeHas('A', charlieSubscription.hash);

  // Charlie's response has a V output -- matches V subscriptions.
  const response = makeBlock(
    'charlie-resp2',
    genesis,
    [makeOutput(50, 'verifier-v')],
    20,
  );
  net.submitBlock(response, 'C');
  net.flush();

  net.assertNodeHas('B', response.hash);
  net.assertNodeHas('A', response.hash);
});

Deno.test('Routing: 4-node chain routes end-to-end', () => {
  // A <-> B <-> C <-> D -- verifies multi-hop propagation.

  const net = new TestNetwork();
  net.addNode('A', false);
  net.addNode('B', false);
  net.addNode('C', false);
  net.addNode('D', false);

  net.connectPeers('A', 'B');
  net.connectPeers('B', 'C');
  net.connectPeers('C', 'D');

  const genesis = makeGenesis(2);
  net.broadcastGenesis(genesis);

  const V = 'chain-v';
  const blockA = makeBlock('chain-a', genesis, [makeOutput(50, V)], 10);
  const blockD = makeBlock('chain-d', genesis, [makeOutput(50, V)], 10);

  // Seed nodes with their own blocks.
  net.getNode('A').receiveBlock(blockA, null);
  net.getNode('D').receiveBlock(blockD, null);

  // Deliver to adjacent intermediaries.
  net.deliverFromPeer(blockA, 'B', 'A');
  net.deliverFromPeer(blockD, 'C', 'D');

  // B and C each have one V subscription. Connect them:
  // B has blockA (from A), C has blockD (from D). Neither knows about
  // the other's V block yet. Deliver blockA from B to C to bridge.
  const blockB = makeBlock('chain-b', genesis, [makeOutput(50, V)], 10);
  net.getNode('B').receiveBlock(blockB, null);
  net.deliverFromPeer(blockB, 'C', 'B');
  net.flush();

  // blockB should have reached D through C, and backfill should have
  // pulled blockD toward B.
  net.assertNodeHas('D', blockB.hash);

  // Now D publishes a response.
  const responseD = makeBlock('chain-d-resp', genesis, [makeOutput(50, V)], 20);
  net.submitBlock(responseD, 'D');
  net.flush();

  // Response should propagate D -> C -> B.
  net.assertNodeHas('C', responseD.hash);
  net.assertNodeHas('B', responseD.hash);
});
