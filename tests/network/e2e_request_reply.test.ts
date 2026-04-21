/**
 * End-to-end request/reply demo test.
 *
 * Three Scaffold instances A, B, C wired in a line A -- B -- C. C has the
 * Hello contract registered; A and B do not. A manual delivery bus
 * translates each Scaffold's push actions into the target's processBlock
 * call so the protocol runs without any real transport.
 *
 * Flow:
 *   1. C publishes a capability-seed block that self-claims a HELLO output.
 *   2. The seed is shipped C -> B -> A directly (the manual "hacky send"
 *      pattern the user described). After this, both B and A have a claim
 *      history entry pointing at C for the HELLO contract.
 *   3. A subscribes to fetch() for { HELLO, "world" }.
 *   4. A publishes a request block with a HELLO("world") output, anchored
 *      to genesis.
 *   5. Rule-2 routing carries the request A -> B -> C.
 *   6. C's DraftStrategy + ContractGenerator produce a response block
 *      that claims A's request output and emits a RECORD "response"
 *      output containing "Hello, world".
 *   7. Rule-1 routing carries the response C -> B -> A.
 *   8. A's fetch subscription fires with "Hello, world".
 */

import { assertEquals } from '@std/assert';
import { Scaffold } from '../../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../../src/genesis.ts';
import {
  HELLO_CONTRACT,
  helloContract,
  makeHelloRequest,
} from '../../src/contracts/HelloContract.ts';
import { BlockAwareness } from '../../src/node/RoutingModule.ts';
import { Hash } from '../../src/util/Hash.ts';
import { Block } from '../../src/core/Block.ts';

class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();
  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }
  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

function waitFor<T>(
  poll: () => T | null | undefined,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    const tick = () => {
      const v = poll();
      if (v !== null && v !== undefined) return resolve(v);
      if (performance.now() > deadline) {
        return reject(new Error(`timeout after ${timeoutMs}ms`));
      }
      setTimeout(tick, 1);
    };
    tick();
  });
}

Deno.test('e2e: request/reply via claim-history gossip', async () => {
  const seeds = ['a', 'b', 'c'] as const;
  const genesis = computeDemoGenesis(seeds);

  const nodeA = new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis,
    enableLogging: false,
  });
  const nodeB = new Scaffold({
    privateKey: demoPrivateKey('b'),
    genesis,
    enableLogging: false,
  });
  const nodeC = new Scaffold({
    privateKey: demoPrivateKey('c'),
    genesis,
    enableLogging: false,
    // Only auto-draft for the Hello contract; without this, C would draft
    // against every aggregation marker on every canonical block.
    enableGeneration: (hash) => Hash.equals(hash, HELLO_CONTRACT),
  });

  nodeC.registerContract(HELLO_CONTRACT, helloContract);

  const hexA = nodeA.publicKeyHex;
  const hexB = nodeB.publicKeyHex;
  const hexC = nodeC.publicKeyHex;

  // Topology: A <-> B <-> C. B is the middleman.
  nodeA.context.routing.addPeer(hexB, hexB, new SetAwareness());
  nodeB.context.routing.addPeer(hexA, hexA, new SetAwareness());
  nodeB.context.routing.addPeer(hexC, hexC, new SetAwareness());
  nodeC.context.routing.addPeer(hexB, hexB, new SetAwareness());

  // Manual delivery bus: each scaffold's push actions deliver directly into
  // the target's processBlock with fromPeer = source pubkey hex. queueMicrotask
  // avoids re-entrant processing.
  const nodes: Record<string, Scaffold> = {
    [hexA]: nodeA,
    [hexB]: nodeB,
    [hexC]: nodeC,
  };
  const wire = (from: Scaffold, fromHex: string) => {
    from.context.routing.onPushAction((action) => {
      const target = nodes[action.peer];
      if (!target) return;
      const block = from.context.store.get(action.block);
      if (!block) return;
      queueMicrotask(() => target.context.processBlock(block, fromHex));
    });
  };
  wire(nodeA, hexA);
  wire(nodeB, hexB);
  wire(nodeC, hexC);

  // 1. C publishes a capability seed: self-claimed HELLO output, high value
  //    so claim-history routing later clears the minPushPriority threshold.
  const seed = nodeC.put({
    outputs: [makeHelloRequest('seed', 1_000_000)],
    claims: [{ index: 0, value: 1_000_000 }],
  });

  // 2. Hand-relay the seed C -> B -> A so each node records it as arriving
  //    from the previous hop. After this, both B and A can route HELLO
  //    traffic toward C via claim history + receivedFirst.
  nodeB.context.processBlock(seed.block, hexC);
  nodeA.context.processBlock(seed.block, hexB);

  // 3. A subscribes to the response. The subscription fires once for A's
  //    own request block (data=empty) and again for C's response.
  let response: { data: Uint8Array; block: Block } | null = null;
  nodeA.fetch(
    { contractHash: HELLO_CONTRACT, params: new TextEncoder().encode('world') },
    {
      onResult: (result) => {
        if (!result) return;
        const text = new TextDecoder().decode(result.data);
        if (text.startsWith('Hello')) response = result;
      },
    },
  );

  // 4. A publishes the request. Auto-balance resolves the funding UTXO
  //    against the canonical tip's post-subtree vector, so an explicit
  //    anchor isn't needed.
  nodeA.put({
    outputs: [makeHelloRequest('world', 1_000)],
  });

  // 5. Wait for the response to land.
  const result = await waitFor(() => response, 3000);

  assertEquals(
    new TextDecoder().decode(result.data),
    'Hello, world',
    'A should receive the Hello response',
  );

  await nodeA.close();
  await nodeB.close();
  await nodeC.close();
});
