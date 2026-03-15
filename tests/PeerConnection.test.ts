import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block } from '../src/core/Block.ts';
import { createGenesisBlock } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import {
  BlockSerializer,
  createDefaultBlockSerializer,
  PeerConnection,
  PeerMessage,
  TransportConnection,
} from '../src/node/PeerConnection.ts';

// -- Mock Transport ---------------------------------------------------

class MockTransport implements TransportConnection {
  readonly peerId: string;
  readonly sent: string[] = [];

  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private _closed = false;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

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
    this._closed = true;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** Simulate receiving a message from the remote side. */
  simulateMessage(data: string): void {
    if (this.messageHandler) {
      this.messageHandler(data);
    }
  }

  /** Simulate the transport connection closing. */
  simulateClose(): void {
    if (this.closeHandler) {
      this.closeHandler();
    }
  }
}

// -- Test helpers -----------------------------------------------------

function makeTestBlock(): Block {
  const contract = Hash.digest('test-contract');
  return createGenesisBlock([
    {
      verifier: { contract, params: new Uint8Array(0) },
      value: 100,
      detail: new Uint8Array([1, 2, 3]),
    },
  ]);
}

function makeSerializer(): BlockSerializer {
  return createDefaultBlockSerializer();
}

function setup() {
  const transport = new MockTransport('peer-1');
  const receivedBlocks: { block: Block; peerId: string }[] = [];
  const onBlockReceived = (block: Block, peerId: string) => {
    receivedBlocks.push({ block, peerId });
  };
  const serializer = makeSerializer();
  const peer = new PeerConnection(transport, onBlockReceived, serializer);
  return { transport, receivedBlocks, peer, serializer };
}

// -- Tests ------------------------------------------------------------

Deno.test('PeerConnection exposes peerId from transport', () => {
  const { peer } = setup();
  assertEquals(peer.peerId, 'peer-1');
});

Deno.test('sendBlock serializes and sends a block message', () => {
  const { transport, peer } = setup();
  const block = makeTestBlock();

  peer.sendBlock(block);

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'block');
  assert(typeof msg.data === 'object');
});

Deno.test('receiving a block message calls onBlockReceived', () => {
  const { transport, receivedBlocks, serializer } = setup();
  const block = makeTestBlock();

  // Simulate the remote side sending a block
  const message: PeerMessage = {
    type: 'block',
    data: serializer.serialize(block),
  };
  transport.simulateMessage(JSON.stringify(message));

  assertEquals(receivedBlocks.length, 1);
  assertEquals(receivedBlocks[0].peerId, 'peer-1');
  assertEquals(receivedBlocks[0].block.hash.toHex(), block.hash.toHex());
});

Deno.test('block round-trip preserves block fields', () => {
  const { transport, receivedBlocks, serializer } = setup();
  const block = makeTestBlock();

  // Send and then parse what was sent to simulate a round-trip
  const message: PeerMessage = {
    type: 'block',
    data: serializer.serialize(block),
  };
  transport.simulateMessage(JSON.stringify(message));

  const received = receivedBlocks[0].block;
  assertEquals(received.hash.toHex(), block.hash.toHex());
  assertEquals(received.anchor, block.anchor);
  assertEquals(received.aggregates.length, block.aggregates.length);
  assertEquals(received.declaredWeight, block.declaredWeight);
  assertEquals(received.outputs.length, block.outputs.length);
});

Deno.test('sendSignal sends a signal message', () => {
  const { transport, peer } = setup();

  peer.sendSignal('peer-2', 'peer-1', { sdp: 'offer-data' });

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'signal');
  assertEquals((msg.data as { to: string }).to, 'peer-2');
  assertEquals((msg.data as { from: string }).from, 'peer-1');
  assertEquals((msg.data as { payload: unknown }).payload, { sdp: 'offer-data' });
});

Deno.test('receiving a signal message calls onSignal handler', () => {
  const { transport, peer } = setup();
  const received: { to: string; from: string; payload: unknown }[] = [];

  peer.onSignal((data) => received.push(data));

  const message: PeerMessage = {
    type: 'signal',
    data: { to: 'peer-1', from: 'peer-2', payload: { sdp: 'answer' } },
  };
  transport.simulateMessage(JSON.stringify(message));

  assertEquals(received.length, 1);
  assertEquals(received[0].to, 'peer-1');
  assertEquals(received[0].from, 'peer-2');
  assertEquals(received[0].payload, { sdp: 'answer' });
});

Deno.test('sendSync sends a sync message with hex tips', () => {
  const { transport, peer } = setup();
  const tip1 = Hash.digest('tip1');
  const tip2 = Hash.digest('tip2');

  peer.sendSync([tip1, tip2], 10);

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'sync');
  const data = msg.data as { tips: string[]; depth: number };
  assertEquals(data.tips, [tip1.toHex(), tip2.toHex()]);
  assertEquals(data.depth, 10);
});

Deno.test('receiving a sync message calls onSync handler', () => {
  const { transport, peer } = setup();
  const received: { tips: string[]; depth: number }[] = [];

  peer.onSync((data) => received.push(data));

  const message: PeerMessage = {
    type: 'sync',
    data: { tips: ['aabb', 'ccdd'], depth: 5 },
  };
  transport.simulateMessage(JSON.stringify(message));

  assertEquals(received.length, 1);
  assertEquals(received[0].tips, ['aabb', 'ccdd']);
  assertEquals(received[0].depth, 5);
});

Deno.test('requestBlocks sends a request message with hex hashes', () => {
  const { transport, peer } = setup();
  const h1 = Hash.digest('block-1');
  const h2 = Hash.digest('block-2');

  peer.requestBlocks([h1, h2]);

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'request');
  const data = msg.data as { hashes: string[] };
  assertEquals(data.hashes, [h1.toHex(), h2.toHex()]);
});

Deno.test('receiving a request message calls onRequest handler', () => {
  const { transport, peer } = setup();
  const received: { hashes: string[] }[] = [];

  peer.onRequest((data) => received.push(data));

  const message: PeerMessage = {
    type: 'request',
    data: { hashes: ['aabb', 'ccdd'] },
  };
  transport.simulateMessage(JSON.stringify(message));

  assertEquals(received.length, 1);
  assertEquals(received[0].hashes, ['aabb', 'ccdd']);
});

Deno.test('sendDelivery sends a delivery message', () => {
  const { transport, peer } = setup();
  const hash = Hash.digest('delivered-block');

  peer.sendDelivery(hash, true);

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'delivery');
  const data = msg.data as { hash: string; delivered: boolean };
  assertEquals(data.hash, hash.toHex());
  assertEquals(data.delivered, true);
});

Deno.test('sendDelivery sends false delivery status', () => {
  const { transport, peer } = setup();
  const hash = Hash.digest('failed-block');

  peer.sendDelivery(hash, false);

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'delivery');
  const data = msg.data as { hash: string; delivered: boolean };
  assertEquals(data.delivered, false);
});

Deno.test('receiving a delivery message calls onDelivery handler', () => {
  const { transport, peer } = setup();
  const received: { hash: string; delivered: boolean }[] = [];

  peer.onDelivery((data) => received.push(data));

  const message: PeerMessage = {
    type: 'delivery',
    data: { hash: 'aabbccdd', delivered: true },
  };
  transport.simulateMessage(JSON.stringify(message));

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
  peer.close(); // should not throw
  assert(peer.isClosed);
});

Deno.test('sends are no-ops after close', () => {
  const { transport, peer } = setup();
  const block = makeTestBlock();

  peer.close();

  peer.sendBlock(block);
  peer.sendSignal('a', 'b', null);
  peer.sendSync([], 0);
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
  const { transport, receivedBlocks, serializer } = setup();
  const block = makeTestBlock();

  // Close the transport
  transport.simulateClose();

  // Try to deliver a block after close
  const message: PeerMessage = {
    type: 'block',
    data: serializer.serialize(block),
  };
  transport.simulateMessage(JSON.stringify(message));

  assertEquals(receivedBlocks.length, 0);
});

Deno.test('malformed JSON messages are silently ignored', () => {
  const { transport, receivedBlocks } = setup();

  transport.simulateMessage('not valid json {{{');

  assertEquals(receivedBlocks.length, 0);
  // No error thrown -- the connection should still be alive
});

Deno.test('signal message without handler is silently ignored', () => {
  const { transport } = setup();

  // No onSignal handler registered
  const message: PeerMessage = {
    type: 'signal',
    data: { to: 'a', from: 'b', payload: null },
  };
  transport.simulateMessage(JSON.stringify(message));

  // No error thrown
});

Deno.test('multiple message types flow through correctly', () => {
  const { transport, peer, receivedBlocks, serializer } = setup();
  const signals: { to: string; from: string; payload: unknown }[] = [];
  const syncs: { tips: string[]; depth: number }[] = [];
  const requests: { hashes: string[] }[] = [];

  peer.onSignal((data) => signals.push(data));
  peer.onSync((data) => syncs.push(data));
  peer.onRequest((data) => requests.push(data));

  const block = makeTestBlock();

  // Simulate receiving multiple message types
  transport.simulateMessage(
    JSON.stringify({ type: 'block', data: serializer.serialize(block) }),
  );
  transport.simulateMessage(
    JSON.stringify({ type: 'signal', data: { to: 'x', from: 'y', payload: 1 } }),
  );
  transport.simulateMessage(
    JSON.stringify({ type: 'sync', data: { tips: ['aa'], depth: 3 } }),
  );
  transport.simulateMessage(
    JSON.stringify({ type: 'request', data: { hashes: ['bb'] } }),
  );

  assertEquals(receivedBlocks.length, 1);
  assertEquals(signals.length, 1);
  assertEquals(syncs.length, 1);
  assertEquals(requests.length, 1);
});

Deno.test('sendPeerInfo sends a peerInfo message', () => {
  const { transport, peer } = setup();

  peer.sendPeerInfo('my-peer-id', ['contract-a', 'contract-b']);

  assertEquals(transport.sent.length, 1);
  const msg = JSON.parse(transport.sent[0]) as PeerMessage;
  assertEquals(msg.type, 'peerInfo');
  const data = msg.data as { peerId: string; contracts: string[] };
  assertEquals(data.peerId, 'my-peer-id');
  assertEquals(data.contracts, ['contract-a', 'contract-b']);
});

Deno.test('receiving a peerInfo message calls onPeerInfo handler', () => {
  const { transport, peer } = setup();
  const received: { peerId: string; contracts: string[] }[] = [];

  peer.onPeerInfo((data) => received.push(data));

  const message: PeerMessage = {
    type: 'peerInfo',
    data: { peerId: 'remote-peer', contracts: ['c1'] },
  };
  transport.simulateMessage(JSON.stringify(message));

  assertEquals(received.length, 1);
  assertEquals(received[0].peerId, 'remote-peer');
  assertEquals(received[0].contracts, ['c1']);
});
