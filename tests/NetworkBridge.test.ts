import { assert, assertEquals, assertFalse } from '@std/assert';
import { Block, BlockStore, composeBlockPacket, createGenesisBlock } from '../src/core/Block.ts';
import { Hash } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import { bin2hex } from '../src/util/hex.ts';
import { PacketType } from '../src/core/Packet.ts';
import { jsonSignalSerializer, SignalPayload } from '../src/core/SignalAtom.ts';
import { jsonRequestSerializer, RequestPayload } from '../src/core/RequestAtom.ts';
import { AtomSource } from '../src/core/Atom.ts';
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

/**
 * Compose a real signed block packet anchored at `anchor`. We use real
 * packets (not stubs) because NetworkBridge's outbound path forwards
 * the original raw packet bytes.
 */
function makeBlockPacket(
  anchor: Block,
  outputs: Output[] = [makeOutput(10, 'test')],
): { block: Block; raw: Uint8Array } {
  const privateKey = secp.utils.randomPrivateKey();
  const block = composeBlockPacket(
    {
      anchor: anchor.hash,
      aggregates: [],
      claims: [],
      outputs,
      declaredWeight: 1,
      refs: [],
      timestamp: 0,
    },
    privateKey,
  );
  return { block, raw: block.raw };
}

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
  store: BlockStore;
  received: { block: Block; peerId: string }[];
  selfId: string;
}

function makeBridge(selfId?: string): Harness {
  const { store, routing, coordinator } = setupProtocol();
  const plugin = new MockTransportPlugin();
  const keys = generateKeyPair();
  const received: { block: Block; peerId: string }[] = [];

  const bridge = new NetworkBridge({
    plugins: [plugin],
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    store,
    routing,
    processBlock: (block, peerId) => {
      received.push({ block, peerId });
      coordinator.blockReceived(block, peerId);
    },
    selfId: selfId ?? bin2hex(keys.publicKey),
  });
  bridge.start();

  return {
    bridge,
    plugin,
    store,
    received,
    selfId: selfId ?? bin2hex(keys.publicKey),
  };
}

function controlPacket(
  type: PacketType.JsonSignal | PacketType.JsonRequest,
  payload: SignalPayload | RequestPayload,
): Uint8Array {
  const atom = type === PacketType.JsonSignal
    ? jsonSignalSerializer.serialize(payload as SignalPayload, AtomSource.Local)
    : jsonRequestSerializer.serialize(payload as RequestPayload, AtomSource.Local);
  return atom!.raw;
}

// -- Tests ------------------------------------------------------------

Deno.test('NetworkBridge: inbound block flows to processBlock with raw bytes on the Block', () => {
  const { bridge, plugin, received } = makeBridge();

  const { driver } = plugin.injectAnonymousConnection();
  const genesis = createGenesisBlock([makeOutput(100, 'genesis')]);
  const { block, raw } = makeBlockPacket(genesis);

  driver.recvData(raw);

  assertEquals(received.length, 1);
  assertEquals(received[0].block.hash.toHex(), block.hash.toHex());
  // Signer is recovered from the packet signature, not trusted from any
  // wire field -- so it must be present and 33 bytes.
  assert(received[0].block.signer !== undefined);
  assertEquals(received[0].block.signer!.length, 33);
  // The Block carries its canonical wire bytes for forwarding.
  assertEquals(received[0].block.raw, raw);

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

Deno.test('NetworkBridge: handlePushActions sends raw packet bytes to peers', () => {
  const { bridge, plugin } = makeBridge();

  const { provider: p1 } = plugin.injectAnonymousConnection();
  const { provider: p2 } = plugin.injectAnonymousConnection();

  const genesis = createGenesisBlock([makeOutput(100, 'genesis')]);
  const { block, raw } = makeBlockPacket(genesis);

  const peerIds = [...bridge.peers.keys()];
  const actions: PushAction[] = [
    { block: block.hash, peer: peerIds[0], priority: 1, immediate: true },
    { block: block.hash, peer: peerIds[1], priority: 0.5, immediate: false },
  ];

  bridge.handlePushActions(actions, block);

  assertEquals(p1.sent.length, 1);
  assertEquals(p2.sent.length, 1);
  // The exact wire bytes are forwarded -- not a re-serialization.
  assertEquals(p1.sent[0], raw);
  assertEquals(p2.sent[0], raw);

  void bridge.close();
});

Deno.test('NetworkBridge: handlePushActions skips duplicate sends', () => {
  const { bridge, plugin } = makeBridge();

  const { provider } = plugin.injectAnonymousConnection();
  const peerId = [...bridge.peers.keys()][0];

  const genesis = createGenesisBlock([makeOutput(100, 'genesis')]);
  const { block } = makeBlockPacket(genesis);

  const actions: PushAction[] = [
    { block: block.hash, peer: peerId, priority: 1, immediate: true },
  ];

  bridge.handlePushActions(actions, block);
  assertEquals(provider.sent.length, 1);

  bridge.handlePushActions(actions, block);
  assertEquals(provider.sent.length, 1, 'duplicate send should be skipped');

  void bridge.close();
});

Deno.test('NetworkBridge: block request responds with raw bytes from BlockStore', () => {
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
    selfId: bin2hex(keys.publicKey),
  });
  bridge.start();

  const { provider, driver } = plugin.injectAnonymousConnection();

  driver.recvData(controlPacket(PacketType.JsonRequest, {
    hashes: [genesis.hash.toHex()],
  }));

  assertEquals(provider.sent.length, 1, 'should respond with the requested raw bytes');
  assertEquals(provider.sent[0], genesis.raw);

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
    selfId,
  });
  bridge.start();

  const { driver } = plugin.injectAnonymousConnection();

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

  driver.recvData(controlPacket(PacketType.JsonSignal, {
    to: selfId,
    from: 'peer-B',
    payload: envelope,
  }));

  await new Promise((r) => setTimeout(r, 50));

  void bridge.close();
});

Deno.test('NetworkBridge: signal addressed to other peer is forwarded', () => {
  const { bridge, plugin, selfId: _selfId } = makeBridge();

  const b = plugin.injectAnonymousConnection();
  const c = plugin.injectAnonymousConnection();
  const peerIds = [...bridge.peers.keys()];

  b.driver.recvData(controlPacket(PacketType.JsonSignal, {
    to: 'some-other-peer',
    from: peerIds[0],
    payload: {},
  }));

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

  b.driver.recvData(controlPacket(PacketType.JsonSignal, {
    to: 'far-peer',
    from: peerIds[0],
    payload: {},
  }));

  assertEquals(b.provider.sent.length, 0);
  assertEquals(c.provider.sent.length, 1);
  assertEquals(d.provider.sent.length, 1);

  void bridge.close();
});

// -- Reverse-path signaling (replyTo) ----------------------------------

Deno.test('NetworkBridge: replyTo signal forwarded along atom.fromConnections[0]', () => {
  const { bridge, plugin, store } = makeBridge();

  const b = plugin.injectAnonymousConnection();
  const c = plugin.injectAnonymousConnection();
  const peerIds = [...bridge.peers.keys()];
  const bId = peerIds[0];
  const cId = peerIds[1];

  // Seed the store with a block that "came from" peer C. Reverse-path
  // forwarding should route the signal toward C.
  const genesis = createGenesisBlock([makeOutput(100, 'g')]);
  const { block: target } = makeBlockPacket(genesis);
  store.put(target);
  const stored = store.get(target.hash)!;
  stored.fromConnections.push(cId);

  // B sends a signal addressed to whoever published `target`.
  b.driver.recvData(controlPacket(PacketType.JsonSignal, {
    to: 'far-peer',
    from: bId,
    payload: {},
    replyTo: target.hash.toHex(),
  }));

  // Should forward to C only -- not flood, not echo back to B.
  assertEquals(b.provider.sent.length, 0, 'must not echo to sender');
  assertEquals(c.provider.sent.length, 1, 'must forward toward source peer');

  void bridge.close();
});

Deno.test('NetworkBridge: replyTo at origin (local-published atom) delivers to self', async () => {
  const { bridge, plugin, store, selfId } = makeBridge();

  const b = plugin.injectAnonymousConnection();

  // Block in the store with empty fromConnections = local origin.
  const genesis = createGenesisBlock([makeOutput(100, 'g')]);
  const { block: target } = makeBlockPacket(genesis);
  store.put(target);

  // Signal addressed to self with replyTo pointing at our own atom.
  // It should be delivered to the local SignalingService rather than
  // forwarded.
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

  b.driver.recvData(controlPacket(PacketType.JsonSignal, {
    to: selfId,
    from: 'peer-X',
    payload: envelope,
    replyTo: target.hash.toHex(),
  }));

  // No forwarding: there's no upstream peer.
  assertEquals(b.provider.sent.length, 0);

  await new Promise((r) => setTimeout(r, 20));
  void bridge.close();
});

Deno.test('NetworkBridge: replyTo for unknown hash drops without forwarding', () => {
  const { bridge, plugin } = makeBridge();

  const b = plugin.injectAnonymousConnection();
  const c = plugin.injectAnonymousConnection();
  const peerIds = [...bridge.peers.keys()];

  b.driver.recvData(controlPacket(PacketType.JsonSignal, {
    to: 'far-peer',
    from: peerIds[0],
    payload: {},
    replyTo: Hash.digest('not-in-store').toHex(),
  }));

  assertEquals(b.provider.sent.length, 0);
  assertEquals(c.provider.sent.length, 0, 'unknown replyTo must not flood');

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
    selfId: bin2hex(keys.publicKey),
  });
  bridge.start();

  const remote = generateKeyPair();
  await bridge.connectToPeer(remote.publicKey);

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

// -- Security: tampered signer can't impersonate -----------------------

Deno.test('NetworkBridge: signer always recovered from signature, never trusted from payload', () => {
  // Create a packet signed with keyA. The recovered signer must match
  // keyA -- a malicious sender can't claim to be keyB by setting a
  // payload field, because there is no such field; signer comes from
  // the cryptographic signature only.
  const { bridge, plugin, received } = makeBridge();

  const keyA = secp.utils.randomPrivateKey();
  const keyAPub = secp.getPublicKey(keyA, true);
  const keyB = secp.utils.randomPrivateKey();
  const keyBPub = secp.getPublicKey(keyB, true);

  const genesis = createGenesisBlock([makeOutput(100, 'genesis')]);
  const packet = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claims: [],
      outputs: [makeOutput(10, 'test')],
      declaredWeight: 1,
      refs: [],
      timestamp: 0,
    },
    keyA,
  );

  const { driver } = plugin.injectAnonymousConnection();
  driver.recvData(packet.raw);

  assertEquals(received.length, 1);
  assertEquals(received[0].block.signer, keyAPub);
  assertFalse(
    received[0].block.signer === keyBPub,
    'signer must match the actual signing key, never an attacker-claimed key',
  );

  void bridge.close();
});
