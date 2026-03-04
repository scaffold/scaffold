import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Block, BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { SyncProtocol } from '../src/node/SyncProtocol.ts';
import {
  BlockSerializer,
  PeerConnection,
  PeerMessage,
  TransportConnection,
} from '../src/node/PeerConnection.ts';

// -- Test Helpers ---------------------------------------------------

/** Deterministic hash from a string. */
const h = (name: string): Hash => Hash.digest(name);

/** Captures strings sent through the transport so we can inspect messages. */
class MockTransport implements TransportConnection {
  readonly sent: string[] = [];

  private messageHandler: ((data: string) => void) | undefined;
  private closeHandler: (() => void) | undefined;

  constructor(readonly peerId: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    // no-op
  }

  /** Decode the last sent message as JSON. */
  lastMessage(): Record<string, unknown> | undefined {
    if (this.sent.length === 0) return undefined;
    const msg = JSON.parse(this.sent[this.sent.length - 1]) as PeerMessage;
    // Flatten the PeerMessage envelope for easier test assertions
    return { type: msg.type, ...msg.data } as unknown as Record<string, unknown>;
  }
}

/** A no-op block serializer for testing (we never actually send blocks here). */
const stubSerializer: BlockSerializer = {
  serialize(_block: Block): object {
    return {};
  },
  deserialize(_data: object): Block {
    return {} as unknown as Block;
  },
};

function makePeer(id = 'peer-1'): { peer: PeerConnection; transport: MockTransport } {
  const transport = new MockTransport(id);
  const peer = new PeerConnection(
    transport,
    () => {}, // onBlockReceived - not used in sync tests
    stubSerializer,
  );
  return { peer, transport };
}

// -- Tests ----------------------------------------------------------

Deno.test({
  name: 'SyncProtocol: initSync sends sync message with tips and depth',
}, () => {
  const store = new BlockStore();
  const tipHash = h('tip-block');

  const protocol = new SyncProtocol(
    store,
    () => [tipHash],
    () => 42,
  );

  const { peer, transport } = makePeer();
  protocol.initSync(peer);

  const msg = transport.lastMessage();
  assertEquals(msg?.type, 'sync');
  assertEquals(msg?.tips, [tipHash.toHex()]);
  assertEquals(msg?.depth, 42);
});

Deno.test({
  name: 'SyncProtocol: initSync with multiple tips',
}, () => {
  const store = new BlockStore();
  const tips = [h('tip-a'), h('tip-b'), h('tip-c')];

  const protocol = new SyncProtocol(
    store,
    () => tips,
    () => 10,
  );

  const { peer, transport } = makePeer();
  protocol.initSync(peer);

  const msg = transport.lastMessage();
  assertEquals(msg?.type, 'sync');
  assertEquals((msg?.tips as string[]).length, 3);
  assertEquals(msg?.depth, 10);
});

Deno.test({
  name: 'SyncProtocol: handleSync returns hashes we do not have when remote has greater depth',
}, () => {
  const store = new BlockStore();
  // We have none of the remote tips in our store.

  const protocol = new SyncProtocol(
    store,
    () => [],
    () => 5, // our depth is 5
  );

  const { peer, transport } = makePeer();
  const remoteTips = [h('remote-tip-1'), h('remote-tip-2')];

  const needed = protocol.handleSync(
    peer,
    remoteTips.map((t) => t.toHex()),
    10, // remote depth is 10 -- greater than ours
  );

  // We should need both remote tips.
  assertEquals(needed.length, 2);
  assertEquals(needed[0].toHex(), remoteTips[0].toHex());
  assertEquals(needed[1].toHex(), remoteTips[1].toHex());

  // A request message should have been sent.
  const msg = transport.lastMessage();
  assertEquals(msg?.type, 'request');
  assertEquals((msg?.hashes as string[]).length, 2);
});

Deno.test({
  name: 'SyncProtocol: handleSync returns empty when our depth is equal or greater',
}, () => {
  const store = new BlockStore();

  const protocol = new SyncProtocol(
    store,
    () => [h('our-tip')],
    () => 10,
  );

  const { peer, transport } = makePeer();

  // Remote depth equal to ours
  const needed = protocol.handleSync(
    peer,
    [h('their-tip').toHex()],
    10,
  );

  assertEquals(needed.length, 0);
  // No request message should have been sent.
  assertEquals(transport.sent.length, 0);
});

Deno.test({
  name: 'SyncProtocol: handleSync returns empty when we are ahead',
}, () => {
  const store = new BlockStore();

  const protocol = new SyncProtocol(
    store,
    () => [h('our-tip')],
    () => 20,
  );

  const { peer, transport } = makePeer();

  const needed = protocol.handleSync(
    peer,
    [h('their-tip').toHex()],
    5,
  );

  assertEquals(needed.length, 0);
  assertEquals(transport.sent.length, 0);
});

Deno.test({
  name: 'SyncProtocol: handleSync filters out tips we already have',
}, () => {
  const store = new BlockStore();

  // Manually insert a block into the store so we already "have" it.
  // We need a minimal Block -- use createGenesisBlock for convenience.
  const knownTip = h('known-tip');

  // We cannot easily create a block with a predetermined hash, so
  // instead we rely on BlockStore.has().  Put a block whose hash is
  // knownTip.  BlockStore.put requires a full Block object:
  const genesis = createGenesisBlock([]);
  // Override: put it under knownTip by constructing a minimal block.
  // BlockStore keys on block.hash, so we build one manually:
  store.put({
    ...genesis,
    hash: knownTip,
  });

  const protocol = new SyncProtocol(
    store,
    () => [knownTip],
    () => 5,
  );

  const { peer } = makePeer();
  const unknownTip = h('unknown-tip');

  const needed = protocol.handleSync(
    peer,
    [knownTip.toHex(), unknownTip.toHex()],
    10,
  );

  // Only the unknown tip should be returned.
  assertEquals(needed.length, 1);
  assertEquals(needed[0].toHex(), unknownTip.toHex());
});
