import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block, composeBlockPacket, createGenesisBlock } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import { composeUnsignedPacket, PacketType, parsePacket } from '../src/core/Packet.ts';
import { PeerConnection, SignalPayload, TransportConnection } from '../src/node/PeerConnection.ts';

// -- Mock Transport ---------------------------------------------------

class MockTransport implements TransportConnection {
  readonly peerId: string;
  readonly sent: Uint8Array[] = [];

  private messageHandler: ((data: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private _closed = false;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this._closed = true;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Simulate the remote side sending bytes to us. */
  simulateMessage(data: Uint8Array): void {
    this.messageHandler?.(data);
  }

  simulateClose(): void {
    this.closeHandler?.();
  }
}

// -- Test helpers -----------------------------------------------------

function makeTestBlock(): Block {
  const contract = Hash.digest('test-contract');
  return createGenesisBlock([
    {
      verifier: { contract, params: new Uint8Array(0) },
      value: 100,
      data: new Uint8Array([1, 2, 3]),
    },
  ]);
}

function makeSignedBlockPacket() {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  const genesis = makeTestBlock();
  const block = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claims: [],
      outputs: [],
      declaredWeight: 1,
      refs: [],
    },
    privateKey,
  );
  return { block, publicKey };
}

function setup() {
  const transport = new MockTransport('peer-1');
  const receivedBlocks: { block: Block; peerId: string }[] = [];
  const onBlockReceived = (block: Block, peerId: string) => {
    receivedBlocks.push({ block, peerId });
  };
  const peer = new PeerConnection(transport, onBlockReceived);
  return { transport, receivedBlocks, peer };
}

// -- Tests ------------------------------------------------------------

Deno.test('PeerConnection exposes peerId from transport', () => {
  const { peer } = setup();
  assertEquals(peer.peerId, 'peer-1');
});

Deno.test('sendBlock writes raw packet bytes to the transport', () => {
  const { transport, peer } = setup();
  const { block: packet } = makeSignedBlockPacket();

  peer.sendBlock(packet.raw);

  assertEquals(transport.sent.length, 1);
  assertEquals(transport.sent[0], packet.raw);
});

Deno.test('receiving a block packet calls onBlockReceived with recovered signer', () => {
  const { transport, receivedBlocks, peer: _peer } = setup();
  const { block, publicKey } = makeSignedBlockPacket();
  const packet = block;

  transport.simulateMessage(packet.raw);

  assertEquals(receivedBlocks.length, 1);
  assertEquals(receivedBlocks[0].peerId, 'peer-1');
  assertEquals(receivedBlocks[0].block.hash.toHex(), block.hash.toHex());
  assertEquals(receivedBlocks[0].block.signer, publicKey);
  assertEquals(receivedBlocks[0].block.raw, packet.raw);
});

Deno.test('block round-trip preserves block fields', () => {
  const { transport, receivedBlocks } = setup();
  const { block } = makeSignedBlockPacket();
  const packet = block;

  transport.simulateMessage(packet.raw);

  const received = receivedBlocks[0].block;
  assertEquals(received.hash.toHex(), block.hash.toHex());
  assertEquals(received.anchor.toHex(), block.anchor.toHex());
  assertEquals(received.aggregates.length, block.aggregates.length);
  assertEquals(received.declaredWeight, block.declaredWeight);
  assertEquals(received.outputs.length, block.outputs.length);
});

Deno.test('unsigned block packet leaves signer undefined', () => {
  const { transport, receivedBlocks } = setup();
  const genesis = makeTestBlock();
  const packet = composeUnsignedPacket(PacketType.JsonUnsignedBlock, {
    anchor: genesis.hash,
    aggregates: [],
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
    timestamp: 0,
  });

  transport.simulateMessage(packet.raw);

  assertEquals(receivedBlocks.length, 1);
  assertEquals(receivedBlocks[0].block.signer, undefined);
});

Deno.test('sendSignal sends a signal packet', () => {
  const { transport, peer } = setup();

  peer.sendSignal('peer-2', 'peer-1', { sdp: 'offer-data' });

  assertEquals(transport.sent.length, 1);
  const parsed = parsePacket<SignalPayload>(transport.sent[0]);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.Signal);
  assertEquals(parsed!.payload.to, 'peer-2');
  assertEquals(parsed!.payload.from, 'peer-1');
  assertEquals(parsed!.payload.payload, { sdp: 'offer-data' });
});

Deno.test('receiving a signal packet calls onSignal handler', () => {
  const { transport, peer } = setup();
  const received: SignalPayload[] = [];

  peer.onSignal((data) => received.push(data));

  transport.simulateMessage(
    composeUnsignedPacket<SignalPayload>(PacketType.Signal, {
      to: 'peer-1',
      from: 'peer-2',
      payload: { sdp: 'answer' },
    }).raw,
  );

  assertEquals(received.length, 1);
  assertEquals(received[0].to, 'peer-1');
  assertEquals(received[0].from, 'peer-2');
  assertEquals(received[0].payload, { sdp: 'answer' });
});

Deno.test('requestBlocks sends a request packet with hex hashes', () => {
  const { transport, peer } = setup();
  const h1 = Hash.digest('block-1');
  const h2 = Hash.digest('block-2');

  peer.requestBlocks([h1, h2]);

  assertEquals(transport.sent.length, 1);
  const parsed = parsePacket<{ hashes: string[] }>(transport.sent[0]);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.Request);
  assertEquals(parsed!.payload.hashes, [h1.toHex(), h2.toHex()]);
});

Deno.test('receiving a request packet calls onRequest handler', () => {
  const { transport, peer } = setup();
  const received: { hashes: string[] }[] = [];

  peer.onRequest((data) => received.push(data));

  transport.simulateMessage(
    composeUnsignedPacket(PacketType.Request, {
      hashes: ['aabb', 'ccdd'],
    }).raw,
  );

  assertEquals(received.length, 1);
  assertEquals(received[0].hashes, ['aabb', 'ccdd']);
});

Deno.test('sendDelivery sends a delivery packet', () => {
  const { transport, peer } = setup();
  const hash = Hash.digest('delivered-block');

  peer.sendDelivery(hash, true);

  assertEquals(transport.sent.length, 1);
  const parsed = parsePacket<{ hash: string; delivered: boolean }>(transport.sent[0]);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.Delivery);
  assertEquals(parsed!.payload.hash, hash.toHex());
  assertEquals(parsed!.payload.delivered, true);
});

Deno.test('sendDelivery sends false delivery status', () => {
  const { transport, peer } = setup();
  const hash = Hash.digest('failed-block');

  peer.sendDelivery(hash, false);

  const parsed = parsePacket<{ hash: string; delivered: boolean }>(transport.sent[0]);
  assertEquals(parsed!.payload.delivered, false);
});

Deno.test('receiving a delivery packet calls onDelivery handler', () => {
  const { transport, peer } = setup();
  const received: { hash: string; delivered: boolean }[] = [];

  peer.onDelivery((data) => received.push(data));

  transport.simulateMessage(
    composeUnsignedPacket(PacketType.Delivery, {
      hash: 'aabbccdd',
      delivered: true,
    }).raw,
  );

  assertEquals(received.length, 1);
  assertEquals(received[0].hash, 'aabbccdd');
  assertEquals(received[0].delivered, true);
});

Deno.test('close() closes the transport', () => {
  const { transport, peer } = setup();

  assertFalse(peer.isClosed);
  peer.close();
  assert(peer.isClosed);
  assert(transport.closed);
});

Deno.test('close() is idempotent', () => {
  const { peer } = setup();

  peer.close();
  peer.close();
  assert(peer.isClosed);
});

Deno.test('sends are no-ops after close', () => {
  const { transport, peer } = setup();
  const { block: packet } = makeSignedBlockPacket();

  peer.close();

  peer.sendBlock(packet.raw);
  peer.sendSignal('a', 'b', null);
  peer.requestBlocks([]);
  peer.sendDelivery(Hash.digest('x'), true);

  assertEquals(transport.sent.length, 0);
});

Deno.test('transport close triggers onClose handler', () => {
  const { transport, peer } = setup();
  let closeCalled = false;

  peer.onClose(() => {
    closeCalled = true;
  });

  transport.simulateClose();

  assert(closeCalled);
  assert(peer.isClosed);
});

Deno.test('messages after transport close are ignored', () => {
  const { transport, receivedBlocks } = setup();
  const { block: packet } = makeSignedBlockPacket();

  transport.simulateClose();
  transport.simulateMessage(packet.raw);

  assertEquals(receivedBlocks.length, 0);
});

Deno.test('non-Scaffold bytes are silently ignored', () => {
  const { transport, receivedBlocks } = setup();

  transport.simulateMessage(new TextEncoder().encode('not a scaffold packet at all'));

  assertEquals(receivedBlocks.length, 0);
});

Deno.test('signal packet without handler is silently ignored', () => {
  const { transport } = setup();

  transport.simulateMessage(
    composeUnsignedPacket(PacketType.Signal, {
      to: 'a',
      from: 'b',
      payload: null,
    }).raw,
  );

  // No error thrown
});

Deno.test('multiple packet types flow through correctly', () => {
  const { transport, peer, receivedBlocks } = setup();
  const signals: SignalPayload[] = [];
  const requests: { hashes: string[] }[] = [];

  peer.onSignal((data) => signals.push(data));
  peer.onRequest((data) => requests.push(data));

  const { block: packet } = makeSignedBlockPacket();

  transport.simulateMessage(packet.raw);
  transport.simulateMessage(
    composeUnsignedPacket<SignalPayload>(PacketType.Signal, {
      to: 'x',
      from: 'y',
      payload: 1,
    }).raw,
  );
  transport.simulateMessage(
    composeUnsignedPacket(PacketType.Request, { hashes: ['bb'] }).raw,
  );

  assertEquals(receivedBlocks.length, 1);
  assertEquals(signals.length, 1);
  assertEquals(requests.length, 1);
});

Deno.test('sendPeerInfo sends a peerInfo packet', () => {
  const { transport, peer } = setup();

  peer.sendPeerInfo('my-peer-id', ['contract-a', 'contract-b']);

  const parsed = parsePacket<{ peerId: string; contracts: string[] }>(transport.sent[0]);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.PeerInfo);
  assertEquals(parsed!.payload.peerId, 'my-peer-id');
  assertEquals(parsed!.payload.contracts, ['contract-a', 'contract-b']);
});

Deno.test('receiving a peerInfo packet calls onPeerInfo handler', () => {
  const { transport, peer } = setup();
  const received: { peerId: string; contracts: string[] }[] = [];

  peer.onPeerInfo((data) => received.push(data));

  transport.simulateMessage(
    composeUnsignedPacket(PacketType.PeerInfo, {
      peerId: 'remote-peer',
      contracts: ['c1'],
    }).raw,
  );

  assertEquals(received.length, 1);
  assertEquals(received[0].peerId, 'remote-peer');
  assertEquals(received[0].contracts, ['c1']);
});
