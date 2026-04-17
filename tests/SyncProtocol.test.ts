import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { PacketType, parsePacket } from '../src/core/Packet.ts';
import { SyncProtocol } from '../src/node/SyncProtocol.ts';
import { PeerConnection, TransportConnection } from '../src/node/PeerConnection.ts';

// -- Test Helpers ---------------------------------------------------

/** Deterministic hash from a string. */
const h = (name: string): Hash => Hash.digest(name);

/** Captures bytes sent through the transport so we can inspect packets. */
class MockTransport implements TransportConnection {
  readonly sent: Uint8Array[] = [];

  constructor(readonly peerId: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  onMessage(_handler: (data: Uint8Array) => void): void {
    // no-op for these tests; we only inspect outbound traffic.
  }

  onClose(_handler: () => void): void {}

  close(): void {}

  /** Parse the last sent packet and flatten its payload for test assertions. */
  lastMessage(): Record<string, unknown> | undefined {
    if (this.sent.length === 0) return undefined;
    const packet = parsePacket<Record<string, unknown>>(this.sent[this.sent.length - 1]);
    if (!packet) return undefined;
    return {
      type: PacketType[packet.type].toLowerCase(),
      ...packet.payload,
    };
  }
}

function makePeer(id = 'peer-1'): { peer: PeerConnection; transport: MockTransport } {
  const transport = new MockTransport(id);
  const peer = new PeerConnection(transport, () => {});
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
