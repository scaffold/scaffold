import { assert, assertEquals, assertFalse } from '@std/assert';
import {
  Block,
  composeBlockPacket,
  composeUnsignedBlockPacket,
  createGenesisBlock,
} from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import { PacketType } from '../src/core/Packet.ts';
import { PeerConnection, TransportConnection } from '../src/node/PeerConnection.ts';
import { jsonSignalSerializer, SignalAtom } from '../src/core/SignalAtom.ts';
import { jsonRequestSerializer, RequestAtom } from '../src/core/RequestAtom.ts';
import { AtomSource } from '../src/core/Atom.ts';

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
      timestamp: 0,
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
  const block = composeUnsignedBlockPacket({
    anchor: genesis.hash,
    aggregates: [],
    claims: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
    timestamp: 0,
  });

  transport.simulateMessage(block.raw);

  assertEquals(receivedBlocks.length, 1);
  assertEquals(receivedBlocks[0].block.signer, undefined);
});

Deno.test('sendSignal sends a signal packet', () => {
  const { transport, peer } = setup();

  peer.sendSignal('peer-2', 'peer-1', { sdp: 'offer-data' });

  assertEquals(transport.sent.length, 1);
  // Sniff: type byte at index 3 should be JsonSignal.
  assertEquals(transport.sent[0][3], PacketType.JsonSignal);
});

Deno.test('receiving a signal packet calls onSignal handler with atom', () => {
  const { transport, peer } = setup();
  const received: SignalAtom[] = [];

  peer.onSignal((atom) => received.push(atom));

  const inbound = jsonSignalSerializer.serialize(
    { to: 'peer-1', from: 'peer-2', payload: { sdp: 'answer' } },
    AtomSource.Local,
  )!;
  transport.simulateMessage(inbound.raw);

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
  assertEquals(transport.sent[0][3], PacketType.JsonRequest);
});

Deno.test('receiving a request packet calls onRequest handler with atom', () => {
  const { transport, peer } = setup();
  const received: RequestAtom[] = [];

  peer.onRequest((atom) => received.push(atom));

  const h1 = Hash.digest('aa');
  const h2 = Hash.digest('bb');
  const inbound = jsonRequestSerializer.serialize(
    { hashes: [h1.toHex(), h2.toHex()] },
    AtomSource.Local,
  )!;
  transport.simulateMessage(inbound.raw);

  assertEquals(received.length, 1);
  assertEquals(received[0].hashes.length, 2);
  assert(Hash.equals(received[0].hashes[0], h1));
  assert(Hash.equals(received[0].hashes[1], h2));
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

  const atom = jsonSignalSerializer.serialize(
    { to: 'a', from: 'b', payload: null },
    AtomSource.Local,
  )!;
  transport.simulateMessage(atom.raw);

  // No error thrown
});

Deno.test('multiple packet types flow through correctly', () => {
  const { transport, peer, receivedBlocks } = setup();
  const signals: SignalAtom[] = [];
  const requests: RequestAtom[] = [];

  peer.onSignal((atom) => signals.push(atom));
  peer.onRequest((atom) => requests.push(atom));

  const { block: packet } = makeSignedBlockPacket();

  const signalAtom = jsonSignalSerializer.serialize(
    { to: 'x', from: 'y', payload: 1 },
    AtomSource.Local,
  )!;
  const requestAtom = jsonRequestSerializer.serialize(
    { hashes: [Hash.digest('bb').toHex()] },
    AtomSource.Local,
  )!;

  transport.simulateMessage(packet.raw);
  transport.simulateMessage(signalAtom.raw);
  transport.simulateMessage(requestAtom.raw);

  assertEquals(receivedBlocks.length, 1);
  assertEquals(signals.length, 1);
  assertEquals(requests.length, 1);
});

