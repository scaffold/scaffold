import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block, BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { BlockSerializer, TransportConnection } from '../src/node/PeerConnection.ts';
import { NetworkDriver, NetworkPlugin } from '../src/node/NetworkManager.ts';
import { NetworkBridge } from '../src/node/NetworkBridge.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { ConsensusService } from '../src/core/ConsensusService.ts';
import { Coordinator } from '../src/core/Coordinator.ts';
import { GossipService } from '../src/node/GossipService.ts';
import { PushAction } from '../src/node/GossipModule.ts';
import { Output } from '../src/core/BlockCreationModule.ts';

// -- Mock helpers -------------------------------------------------------

function makeOutput(value: number, label?: string): Output {
  return {
    verifier: { contract: Hash.digest(label ?? 'contract'), params: new Uint8Array(0) },
    value,
    data: new Uint8Array([]),
  };
}

function fakeBlock(name: string, anchor?: Hash): Block {
  return {
    hash: Hash.digest(name),
    anchor: anchor ?? ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs: [makeOutput(10)],
    declaredWeight: 1,
    refs: [],
    timestamp: Date.now(),
    receivedAt: Date.now(),
    source: 'local',
  } as unknown as Block;
}

const fakeSerializer: BlockSerializer = {
  serialize(block: Block): object {
    return { hash: block.hash.toHex() };
  },
  deserialize(data: object): Block {
    const d = data as { hash: string };
    return fakeBlock(d.hash);
  },
};

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

  simulateMessage(data: string): void {
    this.messageHandler?.(data);
  }

  simulateDisconnect(): void {
    this.closeHandler?.();
  }
}

class MockNetworkPlugin implements NetworkPlugin {
  started = false;
  stopped = false;
  driver: NetworkDriver | undefined;

  start(driver: NetworkDriver): void {
    this.started = true;
    this.driver = driver;
  }

  stop(): void {
    this.stopped = true;
  }

  connect(_address: string): void {}

  injectConnection(transport: TransportConnection): void {
    this.driver?.onConnection(transport);
  }
}

/** Create a minimal protocol context with store and consensus. */
function setupProtocol() {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const consensus = ctx.get(ConsensusService);
  const coordinator = ctx.get(Coordinator);
  const gossip = new GossipService(ctx);
  return { ctx, store, consensus, coordinator, gossip };
}

// -- Tests --------------------------------------------------------------

Deno.test('NetworkBridge: inbound block flows to processBlock', () => {
  const { store, consensus, gossip } = setupProtocol();
  const received: { block: Block; peerId: string }[] = [];
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: (block, peerId) => received.push({ block, peerId }),
    serializer: fakeSerializer,
  });

  bridge.start();

  const transport = new MockTransport('peer-A');
  plugin.injectConnection(transport);

  // Simulate block arriving from peer
  const block = fakeBlock('inbound-block');
  transport.simulateMessage(JSON.stringify({
    type: 'block',
    data: fakeSerializer.serialize(block),
  }));

  assertEquals(received.length, 1);
  assertEquals(received[0].peerId, 'peer-A');

  bridge.close();
});

Deno.test('NetworkBridge: peer connect registers with gossip', () => {
  const { store, consensus, gossip } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const transport = new MockTransport('peer-B');
  plugin.injectConnection(transport);

  // Gossip should know about the peer -- bestPeerForFetch uses peer set
  // and addPeer was called. We verify by checking the peer exists in the bridge.
  assert(bridge.peers.has('peer-B'));

  bridge.close();
});

Deno.test('NetworkBridge: peer disconnect removes from gossip', () => {
  const { store, consensus, gossip } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const transport = new MockTransport('peer-C');
  plugin.injectConnection(transport);
  assert(bridge.peers.has('peer-C'));

  transport.simulateDisconnect();
  assertFalse(bridge.peers.has('peer-C'));

  bridge.close();
});

Deno.test('NetworkBridge: handlePushActions sends blocks to peers', () => {
  const { store, consensus, gossip } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);

  // Clear sync messages sent on connect
  const t1Before = t1.sent.length;
  const t2Before = t2.sent.length;

  const block = fakeBlock('push-block');
  const actions: PushAction[] = [
    { block: block.hash, peer: 'peer-1', priority: 1, immediate: true },
    { block: block.hash, peer: 'peer-2', priority: 0.5, immediate: false },
  ];

  bridge.handlePushActions(actions, block);

  // Both peers should have received one additional message (the block)
  assertEquals(t1.sent.length - t1Before, 1, 'peer-1 should receive the block');
  assertEquals(t2.sent.length - t2Before, 1, 'peer-2 should receive the block');

  bridge.close();
});

Deno.test('NetworkBridge: handlePushActions skips already-sent blocks', () => {
  const { store, consensus, gossip } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const t1 = new MockTransport('peer-1');
  plugin.injectConnection(t1);

  const t1Before = t1.sent.length;

  const block = fakeBlock('dedup-block');
  const actions: PushAction[] = [
    { block: block.hash, peer: 'peer-1', priority: 1, immediate: true },
  ];

  // Send once
  bridge.handlePushActions(actions, block);
  assertEquals(t1.sent.length - t1Before, 1);

  // Send again -- should be skipped (delivery tracker)
  bridge.handlePushActions(actions, block);
  assertEquals(t1.sent.length - t1Before, 1, 'duplicate send should be skipped');

  bridge.close();
});

Deno.test('NetworkBridge: block request handler responds with blocks from store', () => {
  const { store, consensus, gossip, coordinator } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  // Put a genesis block in the store via coordinator
  const genesis = createGenesisBlock([makeOutput(100)]);
  coordinator.blockReceived(genesis, null);

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const transport = new MockTransport('peer-req');
  plugin.injectConnection(transport);

  // Clear the sync message that was sent on connect
  transport.sent.length = 0;

  // Simulate a block request from the peer
  transport.simulateMessage(JSON.stringify({
    type: 'request',
    data: { hashes: [genesis.hash.toHex()] },
  }));

  // The bridge should have sent the requested block back
  assertEquals(transport.sent.length, 1, 'should respond with the requested block');

  bridge.close();
});

Deno.test('NetworkBridge: sync initiated on peer connect', () => {
  const { store, consensus, gossip } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const transport = new MockTransport('peer-sync');
  plugin.injectConnection(transport);

  // On connect, sync protocol should send our tips
  assert(transport.sent.length > 0, 'should send sync message on connect');

  const msg = JSON.parse(transport.sent[0]);
  assertEquals(msg.type, 'sync');

  bridge.close();
});

Deno.test('NetworkBridge: close shuts down all connections', () => {
  const { store, consensus, gossip } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    consensus,
    gossip,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);

  bridge.close();

  assert(t1.closed, 'transport 1 should be closed');
  assert(t2.closed, 'transport 2 should be closed');
  assert(plugin.stopped, 'plugin should be stopped');
  assertEquals(bridge.peers.size, 0);
});
