import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from '@std/assert';
import { Block, composeUnsignedBlockPacket } from '../src/core/Block.ts';
import { ZERO_HASH } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import { TransportManager } from '../src/node/TransportManager.ts';
import { SignalEnvelope } from '../src/node/SignalingService.ts';
import { MockTransportPlugin } from './helpers/MockTransportPlugin.ts';

// -- Helpers ----------------------------------------------------------

function generateKeyPair() {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

function makeManager(
  plugins: MockTransportPlugin[],
  onBlockReceived: (block: Block, peerId: string) => void = () => {},
): {
  manager: TransportManager;
  sentRelays: { to: string; from: string; payload: SignalEnvelope }[];
} {
  const keys = generateKeyPair();
  const sentRelays: { to: string; from: string; payload: SignalEnvelope }[] = [];

  const manager = new TransportManager({
    plugins,
    selfPrivateKey: keys.privateKey,
    selfPublicKey: keys.publicKey,
    callbacks: { onBlockReceived },
    sendRelay: (to, from, payload) => sentRelays.push({ to, from, payload }),
  });

  return { manager, sentRelays };
}

// -- Tests ------------------------------------------------------------

Deno.test('TransportManager: start calls plugin.start with an anonymous driver', () => {
  const plugin = new MockTransportPlugin();
  const { manager } = makeManager([plugin]);

  manager.start();

  assertEquals(plugin.startedCount, 1);
  assert(plugin.anonymousDriver !== undefined);
});

Deno.test('TransportManager: announceAddresses calls service.announceAddresses on each plugin', () => {
  const a = new MockTransportPlugin({ emitsProtocol: 'a', acceptsProtocols: ['a'] });
  const b = new MockTransportPlugin({ emitsProtocol: 'b', acceptsProtocols: ['b'] });
  const { manager } = makeManager([a, b]);

  manager.start();
  manager.announceAddresses();

  assertEquals(a.announceCount, 1);
  assertEquals(b.announceCount, 1);
});

Deno.test('TransportManager: bootstrapConnection routes to plugin by acceptsProtocols', () => {
  const a = new MockTransportPlugin({ emitsProtocol: 'a', acceptsProtocols: ['proto-a'] });
  const b = new MockTransportPlugin({ emitsProtocol: 'b', acceptsProtocols: ['proto-b'] });
  const { manager } = makeManager([a, b]);

  manager.start();
  manager.bootstrapConnection('proto-b', 'addr://something');

  assertEquals(a.dialCalls.length, 0);
  assertEquals(b.dialCalls, ['addr://something']);
});

Deno.test('TransportManager: bootstrapConnection throws when no plugin accepts the protocol', () => {
  const plugin = new MockTransportPlugin({ emitsProtocol: 'x', acceptsProtocols: ['x'] });
  const { manager } = makeManager([plugin]);
  manager.start();

  assertThrows(
    () => manager.bootstrapConnection('unknown', 'whatever'),
    Error,
    'No plugin accepts protocol',
  );
});

Deno.test('TransportManager: anonymous connection registers a PeerConnection', () => {
  const plugin = new MockTransportPlugin();
  const { manager } = makeManager([plugin]);
  manager.start();

  plugin.injectAnonymousConnection();

  assertEquals(manager.peers.size, 1);
});

Deno.test('TransportManager: close stops all plugins and disconnects peers', async () => {
  const plugin = new MockTransportPlugin();
  const { manager } = makeManager([plugin]);
  manager.start();

  plugin.injectAnonymousConnection();
  plugin.injectAnonymousConnection();
  assertEquals(manager.peers.size, 2);

  await manager.close();

  assertEquals(plugin.stoppedCount, 1);
  assertEquals(manager.peers.size, 0);
});

Deno.test('TransportManager: connectToPeer throws without an authenticated-capable plugin', async () => {
  // Plugin with no emitsProtocol -> cannot initiate
  const plugin = new MockTransportPlugin({ emitsProtocol: null, acceptsProtocols: ['x'] });
  const { manager } = makeManager([plugin]);
  manager.start();

  const peerKey = generateKeyPair().publicKey;

  await assertRejects(
    () => manager.connectToPeer(peerKey),
    Error,
  );

  await manager.close();
});

Deno.test('TransportManager: connectToPeer with a capable plugin produces a signal', async () => {
  const plugin = new MockTransportPlugin();
  const { manager, sentRelays } = makeManager([plugin]);
  manager.start();

  const peerKey = generateKeyPair().publicKey;
  await manager.connectToPeer(peerKey);

  // The plugin gets a driver; sending a signal should go through the encrypted
  // relay and land in sentRelays.
  assertEquals(plugin.authSessions.length, 1);
  plugin.authSessions[0].driver.sendSignal('hello');

  await new Promise((r) => setTimeout(r, 50));
  assert(sentRelays.length >= 1);

  await manager.close();
});

Deno.test('TransportManager: sendBlock broadcasts raw bytes to all peers', () => {
  const plugin = new MockTransportPlugin();
  const { manager } = makeManager([plugin]);
  manager.start();

  const { provider: p1 } = plugin.injectAnonymousConnection();
  const { provider: p2 } = plugin.injectAnonymousConnection();

  // We don't need a real signed block here -- TransportManager just
  // forwards bytes. Use an unsigned-block packet as a stand-in.
  const raw = composeUnsignedBlockPacket({
    anchor: ZERO_HASH,
    aggregates: [],
    claimIndices: [],
    outputs: [],
    declaredWeight: 1,
    refs: [],
    timestamp: 0,
  }).raw;
  manager.sendBlock(raw);

  assertEquals(p1.sent.length, 1);
  assertEquals(p2.sent.length, 1);
  assertEquals(p1.sent[0], raw);
  assertEquals(p2.sent[0], raw);
});

Deno.test('TransportManager: anonymous peer disconnect removes from peers map', () => {
  const plugin = new MockTransportPlugin();
  const { manager } = makeManager([plugin]);
  manager.start();

  const { driver } = plugin.injectAnonymousConnection();
  assertEquals(manager.peers.size, 1);

  driver.close();

  assertEquals(manager.peers.size, 0);
});

Deno.test('TransportManager: plugin without acceptsProtocols still works', () => {
  const plugin = new MockTransportPlugin({ emitsProtocol: 'mock', acceptsProtocols: [] });
  const { manager } = makeManager([plugin]);
  manager.start();
  // Should not throw; just has no accepted protocols
  assertFalse(plugin.acceptsProtocols.includes('mock'));
});
