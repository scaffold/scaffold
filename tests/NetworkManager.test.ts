import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { BlockSerializer, TransportConnection } from '../src/node/PeerConnection.ts';
import {
  NetworkDriver,
  NetworkManager,
  NetworkManagerCallbacks,
  NetworkPlugin,
} from '../src/node/NetworkManager.ts';

// -- Mock helpers -----------------------------------------------------

/** Minimal block for testing. Only the hash field is exercised. */
function fakeBlock(name: string): Block {
  return { hash: Hash.digest(name) } as unknown as Block;
}

/** Trivial serializer that wraps a block in/out of a `{ block }` envelope. */
const fakeSerializer: BlockSerializer = {
  serialize(block: Block): object {
    return { hash: block.hash.toHex() };
  },
  deserialize(data: object): Block {
    const d = data as { hash: string };
    return { hash: Hash.fromHex(d.hash) } as unknown as Block;
  },
};

/** Mock transport that records sends and exposes handlers. */
class MockTransport implements TransportConnection {
  readonly sent: string[] = [];
  closed = false;

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
    this.closed = true;
  }

  /** Simulate the remote side sending us a message. */
  simulateMessage(data: string): void {
    this.messageHandler?.(data);
  }

  /** Simulate the remote side disconnecting. */
  simulateDisconnect(): void {
    this.closeHandler?.();
  }
}

/** Mock plugin that records lifecycle calls and lets tests trigger connections. */
class MockNetworkPlugin implements NetworkPlugin {
  started = false;
  stopped = false;
  readonly connectCalls: string[] = [];
  driver: NetworkDriver | undefined;

  start(driver: NetworkDriver): void {
    this.started = true;
    this.driver = driver;
  }

  stop(): void {
    this.stopped = true;
  }

  connect(address: string): void {
    this.connectCalls.push(address);
  }

  /** Simulate an inbound connection arriving through this plugin. */
  injectConnection(transport: TransportConnection): void {
    this.driver?.onConnection(transport);
  }
}

// -- Tests ------------------------------------------------------------

Deno.test({
  name: 'NetworkManager: onConnection creates a PeerConnection',
}, () => {
  const plugin = new MockNetworkPlugin();
  const received: { block: Block; peerId: string }[] = [];
  const mgr = new NetworkManager(
    [plugin],
    { onBlockReceived: (block, peerId) => received.push({ block, peerId }) },
    fakeSerializer,
  );
  mgr.start();

  const transport = new MockTransport('peer-1');
  plugin.injectConnection(transport);

  assert(mgr.peers.has('peer-1'), 'peer should be registered');
  assertEquals(mgr.peers.size, 1);

  mgr.close();
});

Deno.test({
  name: 'NetworkManager: blocks from peers trigger onBlockReceived',
}, () => {
  const plugin = new MockNetworkPlugin();
  const received: { block: Block; peerId: string }[] = [];
  const mgr = new NetworkManager(
    [plugin],
    { onBlockReceived: (block, peerId) => received.push({ block, peerId }) },
    fakeSerializer,
  );
  mgr.start();

  const transport = new MockTransport('peer-1');
  plugin.injectConnection(transport);

  // Simulate a block arriving over the wire.
  // PeerConnection expects a JSON string containing a PeerMessage.
  const block = fakeBlock('test-block');
  const wireMessage = JSON.stringify({
    type: 'block',
    data: fakeSerializer.serialize(block),
  });
  transport.simulateMessage(wireMessage);

  assertEquals(received.length, 1);
  assertEquals(received[0].peerId, 'peer-1');
  assertEquals(
    received[0].block.hash.toHex(),
    block.hash.toHex(),
  );

  mgr.close();
});

Deno.test({
  name: 'NetworkManager: sendBlock broadcasts to all peers',
}, () => {
  const plugin = new MockNetworkPlugin();
  const mgr = new NetworkManager(
    [plugin],
    { onBlockReceived: () => {} },
    fakeSerializer,
  );
  mgr.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);

  const block = fakeBlock('broadcast');
  mgr.sendBlock(block);

  assertEquals(t1.sent.length, 1);
  assertEquals(t2.sent.length, 1);

  mgr.close();
});

Deno.test({
  name: 'NetworkManager: sendBlock to specific targets',
}, () => {
  const plugin = new MockNetworkPlugin();
  const mgr = new NetworkManager(
    [plugin],
    { onBlockReceived: () => {} },
    fakeSerializer,
  );
  mgr.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  const t3 = new MockTransport('peer-3');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);
  plugin.injectConnection(t3);

  const block = fakeBlock('targeted');
  mgr.sendBlock(block, ['peer-1', 'peer-3']);

  assertEquals(t1.sent.length, 1, 'peer-1 should receive');
  assertEquals(t2.sent.length, 0, 'peer-2 should NOT receive');
  assertEquals(t3.sent.length, 1, 'peer-3 should receive');

  mgr.close();
});

Deno.test({
  name: 'NetworkManager: bootstrap calls connect on every plugin',
}, () => {
  const p1 = new MockNetworkPlugin();
  const p2 = new MockNetworkPlugin();
  const mgr = new NetworkManager(
    [p1, p2],
    { onBlockReceived: () => {} },
    fakeSerializer,
  );
  mgr.start();

  mgr.bootstrap(['addr-a', 'addr-b']);

  assertEquals(p1.connectCalls, ['addr-a', 'addr-b']);
  assertEquals(p2.connectCalls, ['addr-a', 'addr-b']);

  mgr.close();
});

Deno.test({
  name: 'NetworkManager: close disconnects all peers and stops plugins',
}, () => {
  const plugin = new MockNetworkPlugin();
  const mgr = new NetworkManager(
    [plugin],
    { onBlockReceived: () => {} },
    fakeSerializer,
  );
  mgr.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);

  mgr.close();

  assert(t1.closed, 'transport 1 should be closed');
  assert(t2.closed, 'transport 2 should be closed');
  assert(plugin.stopped, 'plugin should be stopped');
  assertEquals(mgr.peers.size, 0, 'peers map should be empty');
});

Deno.test({
  name: 'NetworkManager: peer disconnect removes from peers map',
}, () => {
  const plugin = new MockNetworkPlugin();
  const mgr = new NetworkManager(
    [plugin],
    { onBlockReceived: () => {} },
    fakeSerializer,
  );
  mgr.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);

  assertEquals(mgr.peers.size, 2);

  // Simulate peer-1 dropping off
  t1.simulateDisconnect();

  assertEquals(mgr.peers.size, 1);
  assertFalse(mgr.peers.has('peer-1'), 'peer-1 should be removed');
  assert(mgr.peers.has('peer-2'), 'peer-2 should remain');

  mgr.close();
});
