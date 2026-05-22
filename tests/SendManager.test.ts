// SendManager: send({contract, params, body, value?, onBlock?, onError?})
// publishes a single output. onBlock fires on the initial emission and
// every re-emission after the previous block becomes uncanonical.

import { assertEquals, assertExists } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../src/genesis.ts';
import { Block } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { str2bin } from '../src/util/buffer.ts';

const TEST_VERIFIER_CONTRACT = Hash.digest('scaffold:test:send-verifier');

function makeNode(): Scaffold {
  return new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis: computeDemoGenesis(['a']),
    enableLogging: false,
    enablePiggyback: false,
    enableGeneration: () => false,
  });
}

Deno.test('SendManager.send: onBlock fires with a block carrying the single output', async () => {
  const node = makeNode();
  const params = str2bin('s1');
  const body = new Uint8Array([9, 8, 7]);
  let received: Block | null = null;
  const handle = node.send({
    contract: TEST_VERIFIER_CONTRACT,
    params,
    body,
    onBlock: (b) => {
      received = b;
    },
  });
  assertExists(received, 'onBlock should fire synchronously when anchor is already canonical');
  const verifierOutput = received!.outputs.find((o) =>
    Hash.equals(o.verifier.contract, TEST_VERIFIER_CONTRACT)
  );
  assertExists(verifierOutput);
  assertEquals(verifierOutput!.body, body);
  assertEquals(verifierOutput!.value, 0);
  handle.close();
  await node.close();
});

Deno.test('SendManager.send: value defaults to 0 and accepts explicit values', async () => {
  const node = makeNode();
  let received: Block | null = null;
  const handle = node.send({
    contract: TEST_VERIFIER_CONTRACT,
    params: str2bin('s2'),
    body: new Uint8Array(0),
    value: 42,
    onBlock: (b) => {
      received = b;
    },
  });
  assertExists(received);
  const verifierOutput = received!.outputs.find((o) =>
    Hash.equals(o.verifier.contract, TEST_VERIFIER_CONTRACT)
  );
  assertExists(verifierOutput);
  assertEquals(verifierOutput!.value, 42);
  handle.close();
  await node.close();
});

Deno.test('SendManager.send: close() unsubscribes the callback', async () => {
  const node = makeNode();
  const seen: Block[] = [];
  const handle = node.send({
    contract: TEST_VERIFIER_CONTRACT,
    params: str2bin('cancel-test'),
    body: new Uint8Array(0),
    onBlock: (b) => seen.push(b),
  });
  assertEquals(seen.length, 1, 'one initial emission expected');
  handle.close();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(seen.length, 1, 'no further emissions after close');
  await node.close();
});
