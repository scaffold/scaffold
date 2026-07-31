import {
  assert,
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { AtomSerializerService } from '../src/core/AtomSerializer.ts';
import { BlockStore } from '../src/core/BlockStore.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BLOCK_REF_TYPE,
  BlockAction,
  BlockActionType,
  BlockPayload,
} from '../src/core/types.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { makeTestContext } from './helpers/v2.ts';

function setup() {
  const ctx = makeTestContext();
  const store = ctx.get(BlockStore);
  const genesisRaw = ctx.config.genesis;
  const genesisHash = Hash.digest(genesisRaw);

  const serialize = (payload: Partial<BlockPayload> = {}) =>
    ctx.get(AtomSerializerService).serialize(AtomType.Block, {
      anchor: genesisHash,
      chain: [{ weight: 1n, throughput: 0n }],
      aggregates: [],
      claims: [],
      refs: [],
      outputs: [{ contract: ZERO_HASH, params: new Uint8Array([1]), amount: 0n }],
      timestampMs: 1,
      ...payload,
    });

  const ingest = (raw: Uint8Array, source = AtomSource.Remote, receivedAt = 0) =>
    store.ingest({ source, receivedAt, raw });

  const ingestGenesis = () => ingest(genesisRaw, AtomSource.Genesis);

  return { ctx, store, genesisRaw, genesisHash, serialize, ingest, ingestGenesis };
}

Deno.test('BlockStore.get: mints a BlockRef for an unknown hash', () => {
  const { store } = setup();

  const hash = Hash.digest('unknown-block');
  const ref = store.get(hash);

  assert(ref.type === BLOCK_REF_TYPE);
  assert(Hash.equals(ref.hash, hash));
  assertEquals(ref.connections, []);
  assertEquals(ref.anchoringNodes, []);
  assertEquals(ref.aggregatingNodes, []);
  assertEquals(ref.resolvingOutputs.size, 0);
  assertEquals(ref.listeners.size, 0);
});

Deno.test('BlockStore.get: caches the minted ref by hash value', () => {
  const { store } = setup();

  const hash = Hash.digest('unknown-block');
  const first = store.get(hash);
  const second = store.get(Hash.fromHex(hash.toHex()));

  assertStrictEquals(first, second);
});

Deno.test('BlockStore.get: back-links attached to a ref survive later lookups', () => {
  const { store } = setup();

  const hash = Hash.digest('unknown-block');
  const listener = () => {};
  const ref = store.get(hash);
  assert(ref.type === BLOCK_REF_TYPE);
  ref.listeners.add(listener);
  ref.connections.push('conn-1');

  const again = store.get(hash);
  assert(again.type === BLOCK_REF_TYPE);
  assert(again.listeners.has(listener));
  assertEquals(again.connections, ['conn-1']);
});

Deno.test('BlockStore.ingest: deserializes, stores and returns the block', () => {
  const { store, genesisRaw, genesisHash } = setup();

  const genesis = store.ingest({
    source: AtomSource.Genesis,
    receivedAt: 7,
    raw: genesisRaw,
  });

  assertEquals(genesis.type, AtomType.Block);
  assert(Hash.equals(genesis.hash, genesisHash));
  assertStrictEquals(genesis.raw, genesisRaw);
  assertEquals(genesis.source, AtomSource.Genesis);
  assertEquals(genesis.receivedAt, 7);
  assertEquals(genesis.signer?.byteLength, 33);
  assertEquals(genesis.anchor, undefined);
  assertStrictEquals(store.get(genesisHash), genesis);
});

Deno.test('BlockStore.ingest: preserves the payload of a child block', () => {
  const { genesisHash, serialize, ingest } = setup();

  const block = ingest(serialize({ timestampMs: 42, claims: [0n] }));

  assert(Hash.equals(block.payload.anchor, genesisHash));
  assertEquals(block.payload.timestampMs, 42);
  assertEquals(block.payload.claims, [0n]);
  assertEquals(block.payload.outputs.length, 1);
  assertEquals(block.payload.outputs[0].amount, 0n);
});

Deno.test('BlockStore.ingest: identical bytes return the same object', () => {
  const { store, genesisHash, serialize, ingest, ingestGenesis } = setup();

  const genesis = ingestGenesis();
  const raw = serialize();
  const first = ingest(raw, AtomSource.Remote, 1);
  const second = ingest(raw, AtomSource.Local, 2);

  assertStrictEquals(first, second);
  assertEquals(second.source, AtomSource.Remote);
  assertEquals(second.receivedAt, 1);
  assertStrictEquals(store.get(genesisHash), genesis);
  // A second deserialize would push the child onto its anchor a second time.
  assertEquals(genesis.anchoringNodes, [first]);
});

Deno.test('BlockStore.ingest: re-ingested bytes do not re-notify listeners', () => {
  const { store, serialize, ingest } = setup();

  const seen: Block[] = [];
  store.onIngest((block) => seen.push(block));

  const raw = serialize();
  ingest(raw);
  ingest(raw);

  assertEquals(seen.length, 1);
});

Deno.test('BlockStore.ingest: promotes a ref held for the same hash', () => {
  const { store, genesisRaw, genesisHash, serialize, ingest } = setup();

  const child = ingest(serialize());
  const ref = store.get(genesisHash);
  assert(ref.type === BLOCK_REF_TYPE);
  assertStrictEquals(child.anchor, ref);
  assertEquals(ref.anchoringNodes, [child]);

  const listener = () => {};
  ref.listeners.add(listener);

  const genesis = ingest(genesisRaw, AtomSource.Genesis);

  assertEquals(genesis.type, AtomType.Block);
  assertStrictEquals(store.get(genesisHash), genesis);
  assertNotStrictEquals(store.get(genesisHash), ref);
  assertStrictEquals(child.anchor, genesis);
  assertEquals(genesis.anchoringNodes, [child]);
  // Listeners registered on the ref must keep working after promotion.
  assertStrictEquals(genesis.listeners, ref.listeners);
  assert(genesis.listeners.has(listener));
});

Deno.test('BlockStore.ingest: the block is retrievable from inside an onIngest listener', () => {
  const { store, serialize, ingest } = setup();

  let seen: Block | undefined;
  store.onIngest((block) => {
    seen = store.get(block.hash) as Block;
  });

  const block = ingest(serialize());

  assertStrictEquals(seen, block);
});

Deno.test('BlockStore.onIngest: fires for every ingested block in order', () => {
  const { store, serialize, ingest, ingestGenesis } = setup();

  const seen: Block[] = [];
  store.onIngest((block) => seen.push(block));

  const genesis = ingestGenesis();
  const first = ingest(serialize({ timestampMs: 1 }));
  const second = ingest(serialize({ timestampMs: 2 }));

  assertEquals(seen, [genesis, first, second]);
});

Deno.test('BlockStore.onIngest: aborting the signal unsubscribes', () => {
  const { store, serialize, ingest } = setup();

  const controller = new AbortController();
  let count = 0;
  store.onIngest(() => count++, controller.signal);

  ingest(serialize({ timestampMs: 1 }));
  controller.abort();
  ingest(serialize({ timestampMs: 2 }));

  assertEquals(count, 1);
});

Deno.test('BlockStore.onIngest: an already-aborted signal never subscribes', () => {
  const { store, serialize, ingest } = setup();

  const controller = new AbortController();
  controller.abort();
  let count = 0;
  store.onIngest(() => count++, controller.signal);

  ingest(serialize());

  assertEquals(count, 0);
});

// Subscriptions are a Set of callbacks, so the same function reference cannot hold two
// independent subscriptions: the second registration is a no-op and either signal
// unsubscribes both. Unreachable today (every call site passes a fresh closure), and
// aborting the second signal would trip the `assert` in the unsubscribe path.
Deno.test('BlockStore.onIngest: an identical callback registers only once', () => {
  const { store, serialize, ingest } = setup();

  const first = new AbortController();
  const second = new AbortController();
  let count = 0;
  const callback = () => count++;
  store.onIngest(callback, first.signal);
  store.onIngest(callback, second.signal);

  ingest(serialize({ timestampMs: 1 }));
  assertEquals(count, 1);

  first.abort();
  ingest(serialize({ timestampMs: 2 }));
  assertEquals(count, 1);
});

// The `assert(atom.type === AtomType.Block)` guard in ingest is unreachable: the signal
// and request ingestors are both `UnknownIngestor`, whose deserialize is `todo()`.
Deno.test('BlockStore.ingest: a non-block atom type fails in the deserializer', () => {
  const { store } = setup();

  const signalRaw = new Uint8Array([83, 67, 70, AtomType.Signal, 1, 2, 3]);

  assertThrows(
    () => store.ingest({ source: AtomSource.Remote, receivedAt: 0, raw: signalRaw }),
    Error,
    'Unimplemented',
  );
});

Deno.test('a hash stays usable after malformed bytes fail to ingest', () => {
  const { store, serialize, ingest } = setup();

  const corrupt = new Uint8Array(serialize());
  corrupt[10] ^= 0xff;
  const hash = Hash.digest(corrupt);

  assertThrows(() => ingest(corrupt), Error, 'Not a block');

  const fact = store.get(hash);
  assert(fact.type === BLOCK_REF_TYPE);
});

Deno.test('a rejected block does not poison blocks that reference it', () => {
  const { serialize, ingest, ingestGenesis } = setup();

  ingestGenesis();
  const badRaw = serialize({ claims: [999n] });
  const badHash = Hash.digest(badRaw);
  assertThrows(() => ingest(badRaw), Error, 'Claim index out of bounds');

  const child = ingest(serialize({ anchor: badHash, timestampMs: 2 }));

  assertEquals(child.anchor?.type, BLOCK_REF_TYPE);
});

Deno.test('ingesting a block notifies its anchor', () => {
  const { serialize, ingest, ingestGenesis } = setup();

  const genesis = ingestGenesis();
  const actions: BlockAction[] = [];
  genesis.listeners.add((action) => actions.push(action));

  const child = ingest(serialize());

  assertEquals(actions.length, 1);
  const action = actions[0];
  assert(action.type === BlockActionType.LinkAnchoringNode);
  assertStrictEquals(action.anchoringNode, child);
});

Deno.test('promoting a ref notifies the blocks anchored at it', () => {
  const { genesisRaw, serialize, ingest } = setup();

  const child = ingest(serialize());
  const actions: BlockAction[] = [];
  child.listeners.add((action) => actions.push(action));

  const genesis = ingest(genesisRaw, AtomSource.Genesis);

  assertEquals(actions.length, 1);
  const action = actions[0];
  assert(action.type === BlockActionType.LinkAnchor);
  assertStrictEquals(action.anchor, genesis);
});
