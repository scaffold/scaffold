import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block, BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { BlockSerializer, TransportConnection } from '../src/node/PeerConnection.ts';
import { NetworkDriver, NetworkPlugin } from '../src/node/NetworkManager.ts';
import { NetworkBridge } from '../src/node/NetworkBridge.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { Coordinator } from '../src/core/Coordinator.ts';
import { GossipService } from '../src/node/GossipService.ts';
import { RoutingService } from '../src/node/RoutingService.ts';
import { PushAction } from '../src/node/RoutingModule.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { SignalingService, SignalEnvelope } from '../src/node/SignalingService.ts';
import { secp } from '../src/util/secp.ts';
import { bin2hex } from '../src/util/hex.ts';
import { deriveAesKey, encryptSignal, uint8ToBase64 } from '../src/util/crypto.ts';
import { NetworkProvider, SignalingDriver, SignalingProvider } from '../src/interfaces/network.ts';

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

/** Create a minimal protocol context with store. */
function setupProtocol() {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const coordinator = ctx.get(Coordinator);
  const gossip = new GossipService(ctx);
  const routing = new RoutingService(ctx, gossip);
  return { ctx, store, coordinator, gossip, routing };
}

// -- Tests --------------------------------------------------------------

Deno.test('NetworkBridge: inbound block flows to processBlock', () => {
  const { store, routing } = setupProtocol();
  const received: { block: Block; peerId: string }[] = [];
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
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
  const { store, routing } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
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
  const { store, routing } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
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
  const { store, routing } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const t1 = new MockTransport('peer-1');
  const t2 = new MockTransport('peer-2');
  plugin.injectConnection(t1);
  plugin.injectConnection(t2);

  const block = fakeBlock('push-block');
  const actions: PushAction[] = [
    { block: block.hash, peer: 'peer-1', priority: 1, immediate: true },
    { block: block.hash, peer: 'peer-2', priority: 0.5, immediate: false },
  ];

  bridge.handlePushActions(actions, block);

  // Both peers should have received a message
  assertEquals(t1.sent.length, 1, 'peer-1 should receive the block');
  assertEquals(t2.sent.length, 1, 'peer-2 should receive the block');

  bridge.close();
});

Deno.test('NetworkBridge: handlePushActions skips already-sent blocks', () => {
  const { store, routing } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const t1 = new MockTransport('peer-1');
  plugin.injectConnection(t1);

  const block = fakeBlock('dedup-block');
  const actions: PushAction[] = [
    { block: block.hash, peer: 'peer-1', priority: 1, immediate: true },
  ];

  // Send once
  bridge.handlePushActions(actions, block);
  assertEquals(t1.sent.length, 1);

  // Send again -- should be skipped (delivery tracker)
  bridge.handlePushActions(actions, block);
  assertEquals(t1.sent.length, 1, 'duplicate send should be skipped');

  bridge.close();
});

Deno.test('NetworkBridge: block request handler responds with blocks from store', () => {
  const { store, routing, coordinator } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  // Put a genesis block in the store via coordinator
  const genesis = createGenesisBlock([makeOutput(100)]);
  coordinator.blockReceived(genesis, null);

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
  });

  bridge.start();

  const transport = new MockTransport('peer-req');
  plugin.injectConnection(transport);

  // Simulate a block request from the peer
  transport.simulateMessage(JSON.stringify({
    type: 'request',
    data: { hashes: [genesis.hash.toHex()] },
  }));

  // The bridge should have sent the requested block back
  assertEquals(transport.sent.length, 1, 'should respond with the requested block');

  bridge.close();
});

Deno.test('NetworkBridge: close shuts down all connections', () => {
  const { store, routing } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
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

// -- Signal relay tests -------------------------------------------------

function setupBridgeWithSignaling(selfId: string) {
  const { store, routing } = setupProtocol();
  const plugin = new MockNetworkPlugin();

  const delivered: SignalEnvelope[] = [];
  const mockSignalingService = {
    recvSignal: (envelope: SignalEnvelope) => {
      delivered.push(envelope);
      return Promise.resolve();
    },
    dispose: () => {},
  } as unknown as SignalingService;

  const bridge = new NetworkBridge({
    plugins: [plugin],
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    signalingService: mockSignalingService,
    selfId,
  });

  bridge.start();
  return { bridge, plugin, delivered };
}

Deno.test('NetworkBridge: signal addressed to self is delivered to SignalingService', () => {
  const { bridge, plugin, delivered } = setupBridgeWithSignaling('node-A');

  const transport = new MockTransport('peer-B');
  plugin.injectConnection(transport);

  const envelope: SignalEnvelope = {
    signalingNonce: 'abc123',
    senderPublicKey: 'deadbeef',
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: 'xxx',
    iv: 'yyy',
  };

  transport.simulateMessage(JSON.stringify({
    type: 'signal',
    data: { to: 'node-A', from: 'peer-B', payload: envelope },
  }));

  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].signalingNonce, 'abc123');

  bridge.close();
});

Deno.test('NetworkBridge: signal addressed to other peer is forwarded, not delivered locally', () => {
  const { bridge, plugin, delivered } = setupBridgeWithSignaling('node-A');

  const tB = new MockTransport('peer-B');
  const tC = new MockTransport('peer-C');
  plugin.injectConnection(tB);
  plugin.injectConnection(tC);

  // Signal from B, addressed to C
  tB.simulateMessage(JSON.stringify({
    type: 'signal',
    data: { to: 'node-X', from: 'peer-B', payload: { test: true } },
  }));

  // Should NOT be delivered locally
  assertEquals(delivered.length, 0);

  // Should be forwarded to C but not echoed back to B
  assertEquals(tB.sent.length, 0, 'should not echo back to sender');
  assertEquals(tC.sent.length, 1, 'should forward to other peer');

  const forwarded = JSON.parse(tC.sent[0]);
  assertEquals(forwarded.type, 'signal');
  assertEquals(forwarded.data.to, 'node-X');
  assertEquals(forwarded.data.from, 'peer-B');

  bridge.close();
});

Deno.test('NetworkBridge: signal forwarded to multiple peers, excluding sender', () => {
  const { bridge, plugin, delivered: _ } = setupBridgeWithSignaling('node-A');

  const tB = new MockTransport('peer-B');
  const tC = new MockTransport('peer-C');
  const tD = new MockTransport('peer-D');
  plugin.injectConnection(tB);
  plugin.injectConnection(tC);
  plugin.injectConnection(tD);

  // Signal from C, addressed to someone else
  tC.simulateMessage(JSON.stringify({
    type: 'signal',
    data: { to: 'peer-X', from: 'peer-C', payload: {} },
  }));

  // Forwarded to B and D, not back to C
  assertEquals(tB.sent.length, 1);
  assertEquals(tC.sent.length, 0, 'sender should not receive echo');
  assertEquals(tD.sent.length, 1);

  bridge.close();
});

Deno.test('NetworkBridge: broadcastSignal sends to all connected peers', () => {
  const { bridge, plugin } = setupBridgeWithSignaling('node-A');

  const tB = new MockTransport('peer-B');
  const tC = new MockTransport('peer-C');
  plugin.injectConnection(tB);
  plugin.injectConnection(tC);

  const envelope: SignalEnvelope = {
    signalingNonce: 'test',
    senderPublicKey: 'aabb',
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: 'enc',
    iv: 'iv',
  };

  bridge.broadcastSignal('target-peer', 'node-A', envelope);

  // Both peers should receive the signal
  assertEquals(tB.sent.length, 1);
  assertEquals(tC.sent.length, 1);

  const msgB = JSON.parse(tB.sent[0]);
  assertEquals(msgB.type, 'signal');
  assertEquals(msgB.data.to, 'target-peer');
  assertEquals(msgB.data.from, 'node-A');

  bridge.close();
});

Deno.test('NetworkBridge: addConnection registers new peer through bridge', () => {
  const { bridge, plugin } = setupBridgeWithSignaling('node-A');

  // Start with one regular peer
  const tB = new MockTransport('peer-B');
  plugin.injectConnection(tB);
  assertEquals(bridge.peers.size, 1);

  // Add an externally-established connection (like from WebRTC signaling)
  const externalTransport = new MockTransport('peer-webrtc');
  bridge.addConnection(externalTransport);

  assertEquals(bridge.peers.size, 2);
  assert(bridge.peers.has('peer-webrtc'));

  bridge.close();
});

Deno.test('NetworkBridge: end-to-end signal relay between two bridges', async () => {
  // Setup: Node A <-> Relay Node <-> Node B
  // A and B each have a SignalingService, Relay just forwards

  const privA = secp.utils.randomPrivateKey();
  const pubA = new Uint8Array(secp.getPublicKey(privA, true));
  const privB = secp.utils.randomPrivateKey();
  const pubB = new Uint8Array(secp.getPublicKey(privB, true));

  const idA = bin2hex(pubA);
  const idB = bin2hex(pubB);

  // Track signals received by each service
  const signalsReceivedByA: string[] = [];
  const signalsReceivedByB: string[] = [];

  // Mock providers that send an initial signal on creation (like WebrtcProvider)
  const mockProviderA: NetworkProvider = {
    providesProtocol: 'mock@test',
    createInstance: (driver: SignalingDriver): SignalingProvider => {
      driver.sendSignal(JSON.stringify({ init: 'from-A' }));
      return {
        recvSignal: (signal: string) => signalsReceivedByA.push(signal),
      };
    },
  };

  const mockProviderB: NetworkProvider = {
    providesProtocol: 'mock@test',
    createInstance: (driver: SignalingDriver): SignalingProvider => {
      driver.sendSignal(JSON.stringify({ init: 'from-B' }));
      return {
        recvSignal: (signal: string) => signalsReceivedByB.push(signal),
      };
    },
  };

  // Create protocol contexts
  const protoA = setupProtocol();
  const protoB = setupProtocol();
  const protoRelay = setupProtocol();

  const pluginA = new MockNetworkPlugin();
  const pluginB = new MockNetworkPlugin();
  const pluginRelay = new MockNetworkPlugin();

  // Create services -- sendRelay goes through the bridge
  let bridgeA: NetworkBridge;
  let bridgeB: NetworkBridge;

  const serviceA = new SignalingService({
    selfPrivateKey: privA,
    selfPublicKey: pubA,
    networkProviders: [mockProviderA],
    sendRelay: (to, from, payload) => bridgeA!.broadcastSignal(to, from, payload),
    onNewConnection: () => {},
    retryIntervalMs: 100000, // prevent interference
  });

  const serviceB = new SignalingService({
    selfPrivateKey: privB,
    selfPublicKey: pubB,
    networkProviders: [mockProviderB],
    sendRelay: (to, from, payload) => bridgeB!.broadcastSignal(to, from, payload),
    onNewConnection: () => {},
    retryIntervalMs: 100000,
  });

  // Create bridges
  bridgeA = new NetworkBridge({
    plugins: [pluginA],
    store: protoA.store,
    routing: protoA.routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    signalingService: serviceA,
    selfId: idA,
  });

  const bridgeRelay = new NetworkBridge({
    plugins: [pluginRelay],
    store: protoRelay.store,
    routing: protoRelay.routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    selfId: 'relay-node',
  });

  bridgeB = new NetworkBridge({
    plugins: [pluginB],
    store: protoB.store,
    routing: protoB.routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    signalingService: serviceB,
    selfId: idB,
  });

  bridgeA.start();
  bridgeRelay.start();
  bridgeB.start();

  // Wire up: A <-> Relay <-> B (simulating transport connections)
  const tAtoRelay = new MockTransport('relay-node');
  const tRelayToA = new MockTransport(idA);
  const tBtoRelay = new MockTransport('relay-node');
  const tRelayToB = new MockTransport(idB);

  pluginA.injectConnection(tAtoRelay);
  pluginRelay.injectConnection(tRelayToA);
  pluginRelay.injectConnection(tRelayToB);
  pluginB.injectConnection(tBtoRelay);

  // Cross-wire the transports: when A sends to relay, relay receives it
  // We'll manually relay messages since MockTransport isn't actually connected
  function relayMessages() {
    for (let round = 0; round < 10; round++) {
      let moved = 0;
      while (tAtoRelay.sent.length > 0) {
        tRelayToA.simulateMessage(tAtoRelay.sent.shift()!);
        moved++;
      }
      while (tRelayToB.sent.length > 0) {
        tBtoRelay.simulateMessage(tRelayToB.sent.shift()!);
        moved++;
      }
      while (tBtoRelay.sent.length > 0) {
        tRelayToB.simulateMessage(tBtoRelay.sent.shift()!);
        moved++;
      }
      while (tRelayToA.sent.length > 0) {
        tAtoRelay.simulateMessage(tRelayToA.sent.shift()!);
        moved++;
      }
      if (moved === 0) break;
    }
  }

  // A initiates connection to B
  await serviceA.initiate(pubB);

  // Wait for async encryption, relay, wait for async decryption.
  // Multiple rounds because: encrypt is async -> relay -> decrypt is async.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 50));
    relayMessages();
  }

  // B should have received a signal
  assert(signalsReceivedByB.length > 0, 'B should have received at least one signal from A');

  serviceA.dispose();
  serviceB.dispose();
  bridgeA.close();
  bridgeRelay.close();
  bridgeB.close();
});
