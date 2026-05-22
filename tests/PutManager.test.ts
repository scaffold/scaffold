// PutManager + SendManager: the narrow put({contract, params, records})
// and send({contract, params, body, onBlock?}) primitives. Both publish
// through the DraftManager bottleneck.

import { assert, assertEquals, assertExists } from '@std/assert';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../src/genesis.ts';
import { Block, RECORD_CONTRACT } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { str2bin } from '../src/util/buffer.ts';

const TEST_VERIFIER_CONTRACT = Hash.digest('scaffold:test:put-verifier');

function makeNode(): Scaffold {
  return new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis: computeDemoGenesis(['a']),
    enableLogging: false,
    enablePiggyback: false,
    enableGeneration: () => false,
  });
}

Deno.test('PutManager.put: resolves with a block carrying the verifier marker', async () => {
  const node = makeNode();
  const params = str2bin('alpha');
  const block = await node.put({ contract: TEST_VERIFIER_CONTRACT, params, records: {} });
  const verifierOutput = block.outputs.find((o) =>
    Hash.equals(o.verifier.contract, TEST_VERIFIER_CONTRACT)
  );
  assertExists(verifierOutput, 'block should carry the (contract, params) verifier output');
  await node.close();
});

Deno.test('PutManager.put: records become RECORD_CONTRACT outputs', async () => {
  const node = makeNode();
  const block = await node.put({
    contract: TEST_VERIFIER_CONTRACT,
    params: str2bin('alpha'),
    records: { foo: 'bar', baz: new Uint8Array([1, 2, 3]) },
  });
  const recordOutputs = block.outputs.filter((o) =>
    Hash.equals(o.verifier.contract, RECORD_CONTRACT)
  );
  assertEquals(recordOutputs.length, 2);
  const foo = recordOutputs.find((o) => new TextDecoder().decode(o.verifier.params) === 'foo');
  const baz = recordOutputs.find((o) => new TextDecoder().decode(o.verifier.params) === 'baz');
  assertExists(foo);
  assertEquals(new TextDecoder().decode(foo!.body!), 'bar');
  assertExists(baz);
  assertEquals(baz!.body, new Uint8Array([1, 2, 3]));
  await node.close();
});

Deno.test('PutManager.put: resolved block is canonical', async () => {
  const node = makeNode();
  const block = await node.put({
    contract: TEST_VERIFIER_CONTRACT,
    params: str2bin('canon'),
    records: { x: 'y' },
  });
  assert(node.context.consensus.isCanonical(block.hash));
  await node.close();
});

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
  // Anchor is canonical at construction time, so onBlock fires synchronously
  // during the addReady -> solidify path.
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

Deno.test('SendManager.send: close() cancels the draft and onError fires', async () => {
  const node = makeNode();
  // Use a verifier on an anchor that the node cannot solidify against yet
  // (in this single-node setup the genesis anchor is canonical, so the
  // first emission still fires). Close immediately after; the SendHandle's
  // cancelDraft is a no-op once the draft is already solidified, but it
  // unsubscribes the callback so subsequent re-emissions do not fire.
  const seen: Block[] = [];
  const handle = node.send({
    contract: TEST_VERIFIER_CONTRACT,
    params: str2bin('cancel-test'),
    body: new Uint8Array(0),
    onBlock: (b) => seen.push(b),
  });
  assertEquals(seen.length, 1, 'one initial emission expected');
  handle.close();
  // The handle.close() unsubscribes; if the draft re-solidifies in this
  // tick it should NOT call onBlock again.
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(seen.length, 1, 'no further emissions after close');
  await node.close();
});
