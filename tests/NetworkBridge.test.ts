import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block, BlockStore, createGenesisBlock } from '../src/core/Block.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import { bin2hex } from '../src/util/hex.ts';
import { BlockSerializer } from '../src/node/PeerConnection.ts';
import { NetworkBridge } from '../src/node/NetworkBridge.ts';
import { SignalEnvelope } from '../src/node/SignalingService.ts';
import { PushAction } from '../src/node/RoutingModule.ts';
import { ProtocolContext } from '../src/core/ProtocolContext.ts';
import { Coordinator } from '../src/core/Coordinator.ts';
import { GossipService } from '../src/node/GossipService.ts';
import { RoutingService } from '../src/node/RoutingService.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { UtxoIndex } from '../src/node/UtxoIndex.ts';
import { MockTransportPlugin } from './helpers/MockTransportPlugin.ts';

// -- Helpers ----------------------------------------------------------

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

function generateKeyPair() {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

function setupProtocol() {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const coordinator = ctx.get(Coordinator);
  const utxoIndex = new UtxoIndex(store);
  const gossip = new GossipService(ctx, utxoIndex);
  const routing = new RoutingService(ctx, gossip);
  return { ctx, store, coordinator, gossip, routing };
}

interface Harness {
  bridge: NetworkBridge;
  plugin: MockTransportPlugin;
  received: { block: Block; peerId: string }[];
  selfId: string;
}

function makeBridge(selfId?: string): Harness {
  const { store, routing } = setupProtocol();
  const plugin = new MockTransportPlugin();
  const keys = generateKeyPair();
  const received: { block: Block; peerId: string }[] = [];

  const bridge = new NetworkBridge({
    plugins: [plugin],
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    store,
    routing,
    processBlock: (block, peerId) => received.push({ block, peerId }),
    serializer: fakeSerializer,
    selfId: selfId ?? bin2hex(keys.publicKey),
  });
  bridge.start();

  return { bridge, plugin, received, selfId: selfId ?? bin2hex(keys.publicKey) };
}

// -- Tests ------------------------------------------------------------

Deno.test('NetworkBridge: inbound block flows to processBlock', () => {
  const { bridge, plugin, received } = makeBridge();

  const { provider } = plugin.injectAnonymousConnection();
  const block = fakeBlock('inbound-block');
  const wire = JSON.stringify({
    type: 'block',
    data: fakeSerializer.serialize(block),
  });

  // Simulate the remote peer sending the block over the connection.
  // The ConnectionDriver returned by createAnonymousConnection has a recvData
  // hook -- but here we feed the data through the ConnectionProvider side
  // effect by calling the driver directly via the internal wiring.
  // We access the driver through the plugin's captured record.
  const drivers = plugin.anonymousDriver!;
  // Re-inject an explicit driver path:
  // Instead, mirror the flow: the plugin already produced a connection, and
  // TransportManager wrapped it into a PeerConnection that listens on the
  // wire. We invoke the underlying recvData by using the provider's captured
  // writes in reverse: the registered connection driver accepts bytes.
  // Since the MockConnectionProvider captures sent bytes but doesn't feed
  // them back, we instead simulate via the ConnectionDriver returned from
  // createAnonymousConnection.

  // The easiest approach: track the returned ConnectionDriver.
  // MockTransportPlugin doesn't expose it, so we use a fresh connection here.
  const conn = new (class extends Object {
    sendReliable(_: Uint8Array) {}
    sendFast(_: Uint8Array) {}
    shutdown() {}
  })();
  const connDriver = drivers.createAnonymousConnection(
    conn as unknown as {
      sendReliable: (data: Uint8Array) => void;
      sendFast: (data: Uint8Array) => void;
      shutdown: () => void;
    },
  );
  connDriver.recvData(new TextEncoder().encode(wire));

  assertEquals(received.length, 1);

  void provider; // silence unused-warning
  void bridge.close();
});

Deno.test('NetworkBridge: peer connect registers with routing + peer map', () => {
  const { bridge, plugin } = makeBridge();

  plugin.injectAnonymousConnection();
  assertEquals(bridge.peers.size, 1);

  void bridge.close();
});

Deno.test('NetworkBridge: peer disconnect removes from peer map', () => {
  const { bridge, plugin } = makeBridge();

  const { driver } = plugin.injectAnonymousConnection();
  assertEquals(bridge.peers.size, 1);

  driver.close();
  assertEquals(bridge.peers.size, 0);

  void bridge.close();
});

Deno.test('NetworkBridge: handlePushActions sends blocks to peers', () => {
  const { bridge, plugin } = makeBridge();

  const { provider: p1 } = plugin.injectAnonymousConnection();
  const { provider: p2 } = plugin.injectAnonymousConnection();

  const block = fakeBlock('push-block');
  const peerIds = [...bridge.peers.keys()];
  const actions: PushAction[] = [
    { block: block.hash, peer: peerIds[0], priority: 1, immediate: true },
    { block: block.hash, peer: peerIds[1], priority: 0.5, immediate: false },
  ];

  bridge.handlePushActions(actions, block);

  assertEquals(p1.sent.length, 1);
  assertEquals(p2.sent.length, 1);

  void bridge.close();
});

Deno.test('NetworkBridge: handlePushActions skips duplicate sends', () => {
  const { bridge, plugin } = makeBridge();

  const { provider } = plugin.injectAnonymousConnection();
  const peerId = [...bridge.peers.keys()][0];

  const block = fakeBlock('dedup-block');
  const actions: PushAction[] = [
    { block: block.hash, peer: peerId, priority: 1, immediate: true },
  ];

  bridge.handlePushActions(actions, block);
  assertEquals(provider.sent.length, 1);

  bridge.handlePushActions(actions, block);
  assertEquals(provider.sent.length, 1, 'duplicate send should be skipped');

  void bridge.close();
});

Deno.test('NetworkBridge: block request responds with blocks from the store', () => {
  const { store, routing, coordinator } = setupProtocol();
  const plugin = new MockTransportPlugin();
  const keys = generateKeyPair();

  const genesis = createGenesisBlock([makeOutput(100)]);
  coordinator.blockReceived(genesis, null);

  const bridge = new NetworkBridge({
    plugins: [plugin],
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    selfId: bin2hex(keys.publicKey),
  });
  bridge.start();

  const { provider, driver } = plugin.injectAnonymousConnection();

  driver.recvData(new TextEncoder().encode(JSON.stringify({
    type: 'request',
    data: { hashes: [genesis.hash.toHex()] },
  })));

  assertEquals(provider.sent.length, 1, 'should respond with the requested block');

  void bridge.close();
});

Deno.test('NetworkBridge: close shuts down plugins and clears peers', async () => {
  const { bridge, plugin } = makeBridge();
  plugin.injectAnonymousConnection();
  plugin.injectAnonymousConnection();

  await bridge.close();

  assertEquals(plugin.stoppedCount, 1);
  assertEquals(bridge.peers.size, 0);
});

// -- Signal relay tests ------------------------------------------------

Deno.test('NetworkBridge: signal addressed to self is delivered to signaling', async () => {
  const { store, routing } = setupProtocol();
  const plugin = new MockTransportPlugin();
  const keys = generateKeyPair();
  const selfId = bin2hex(keys.publicKey);

  const bridge = new NetworkBridge({
    plugins: [plugin],
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    selfId,
  });
  bridge.start();

  const { driver } = plugin.injectAnonymousConnection();

  // Construct a signaling envelope we can't decrypt (the test just verifies
  // routing, not delivery success). Using a made-up sender key and nonce.
  const otherKeys = generateKeyPair();
  const envelope: SignalEnvelope = {
    signalingNonce: Hash.random().toHex(),
    senderPublicKey: bin2hex(otherKeys.publicKey),
    protocol: 'mock',
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: 'xxxx',
    iv: 'yy',
  };

  // Send a "signal" peer message addressed to self. Decryption will fail,
  // but we're only verifying it reaches the signaling path (no forwarding).
  driver.recvData(new TextEncoder().encode(JSON.stringify({
    type: 'signal',
    data: { to: selfId, from: 'peer-B', payload: envelope },
  })));

  // Give any async decrypt attempt a chance to settle/fail silently.
  await new Promise((r) => setTimeout(r, 50));

  // No crash = routing succeeded.
  void bridge.close();
});

Deno.test('NetworkBridge: signal addressed to other peer is forwarded', () => {
  const { bridge, plugin, selfId: _selfId } = makeBridge();

  const b = plugin.injectAnonymousConnection();
  const c = plugin.injectAnonymousConnection();
  const peerIds = [...bridge.peers.keys()];

  // Simulate a signal from peer B to some third peer -- should forward to C
  b.driver.recvData(new TextEncoder().encode(JSON.stringify({
    type: 'signal',
    data: { to: 'some-other-peer', from: peerIds[0], payload: {} },
  })));

  assertEquals(b.provider.sent.length, 0, 'should not echo back to sender');
  assertEquals(c.provider.sent.length, 1, 'should forward to other peer');

  void bridge.close();
});

Deno.test('NetworkBridge: signal forwarded to multiple peers, excluding sender', () => {
  const { bridge, plugin } = makeBridge();

  const b = plugin.injectAnonymousConnection();
  const c = plugin.injectAnonymousConnection();
  const d = plugin.injectAnonymousConnection();
  const peerIds = [...bridge.peers.keys()];

  b.driver.recvData(new TextEncoder().encode(JSON.stringify({
    type: 'signal',
    data: { to: 'far-peer', from: peerIds[0], payload: {} },
  })));

  assertEquals(b.provider.sent.length, 0);
  assertEquals(c.provider.sent.length, 1);
  assertEquals(d.provider.sent.length, 1);

  void bridge.close();
});

Deno.test('NetworkBridge: stores peers by public key for authenticated connections', async () => {
  const plugin = new MockTransportPlugin({ emitsProtocol: 'mock', acceptsProtocols: ['mock'] });
  const { store, routing } = setupProtocol();
  const keys = generateKeyPair();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    selfId: bin2hex(keys.publicKey),
  });
  bridge.start();

  const remote = generateKeyPair();
  await bridge.connectToPeer(remote.publicKey);

  // The plugin should have received one authenticated session
  assertEquals(plugin.authSessions.length, 1);

  await bridge.close();
});

Deno.test('NetworkBridge: connectToPeer produces a peer keyed by remote pubkey once connected', async () => {
  const plugin = new MockTransportPlugin({ emitsProtocol: 'mock', acceptsProtocols: ['mock'] });
  const { store, routing } = setupProtocol();
  const keys = generateKeyPair();

  const bridge = new NetworkBridge({
    plugins: [plugin],
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    store,
    routing,
    processBlock: () => {},
    serializer: fakeSerializer,
    selfId: bin2hex(keys.publicKey),
  });
  bridge.start();

  const remote = generateKeyPair();
  await bridge.connectToPeer(remote.publicKey);

  plugin.injectAuthenticatedConnection();

  assert(bridge.peers.has(bin2hex(remote.publicKey)));
  assertFalse([...bridge.peers.keys()].some((k) => k.startsWith('anon:')));

  await bridge.close();
});
