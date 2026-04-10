import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { bin2hex } from '../src/util/hex.ts';
import { secp } from '../src/util/secp.ts';
import {
  base64ToUint8,
  decryptSignal,
  deriveAesKey,
  encryptSignal,
  uint8ToBase64,
} from '../src/util/crypto.ts';
import {
  SignalingService,
  SignalEnvelope,
} from '../src/node/SignalingService.ts';
import {
  ConnectionDriver,
  ConnectionProvider,
  NetworkProvider,
  SignalingDriver,
  SignalingProvider,
} from '../src/interfaces/network.ts';

// -- Helpers ------------------------------------------------------------

function generateKeyPair() {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

// -- Crypto tests -------------------------------------------------------

Deno.test('crypto: encrypt then decrypt round-trip', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const sharedA = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const aesKey = await deriveAesKey(sharedA);

  const plaintext = new TextEncoder().encode('hello world');
  const { encrypted, iv } = await encryptSignal(plaintext, aesKey);
  const decrypted = await decryptSignal(encrypted, iv, aesKey);

  assertEquals(new TextDecoder().decode(decrypted), 'hello world');
});

Deno.test('crypto: ECDH shared secret is symmetric', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const sharedA = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const sharedB = secp.getSharedSecret(keyB.privateKey, keyA.publicKey);

  const aesKeyA = await deriveAesKey(sharedA);
  const aesKeyB = await deriveAesKey(sharedB);

  // A encrypts, B decrypts
  const plaintext = new TextEncoder().encode('secret message');
  const { encrypted, iv } = await encryptSignal(plaintext, aesKeyA);
  const decrypted = await decryptSignal(encrypted, iv, aesKeyB);

  assertEquals(new TextDecoder().decode(decrypted), 'secret message');
});

Deno.test('crypto: base64 round-trip', () => {
  const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
  const b64 = uint8ToBase64(data);
  const back = base64ToUint8(b64);
  assertEquals(back, data);
});

Deno.test('crypto: token derivation matches on both sides', () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const nonce = Hash.random().toBytes();

  const sharedA = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const sharedB = secp.getSharedSecret(keyB.privateKey, keyA.publicKey);

  // A's token for validation by B
  const tokenA = Hash.digestParts(keyA.publicKey, sharedA, nonce);
  // B computes what A's token should be
  const expectedA = Hash.digestParts(keyA.publicKey, sharedB, nonce);
  assert(Hash.equals(tokenA, expectedA));

  // B's token for validation by A
  const tokenB = Hash.digestParts(keyB.publicKey, sharedB, nonce);
  const expectedB = Hash.digestParts(keyB.publicKey, sharedA, nonce);
  assert(Hash.equals(tokenB, expectedB));

  // Tokens are different from each other
  assertNotEquals(tokenA.toHex(), tokenB.toHex());
});

// -- Mock NetworkProvider -----------------------------------------------

/** Records signals sent through the driver and allows delivering signals back. */
class MockProvider implements NetworkProvider {
  readonly providesProtocol = 'mock@test';
  instances: { driver: SignalingDriver; provider: SignalingProvider }[] = [];

  createInstance(driver: SignalingDriver): SignalingProvider {
    const provider: SignalingProvider = {
      recvSignal: (_signal: string, _orderIdx: number) => {},
      dispose: () => {},
    };
    this.instances.push({ driver, provider });
    return provider;
  }
}

// -- SignalingService tests ----------------------------------------------

Deno.test('SignalingService: initiate creates a session and sends a signal', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const mockProvider = new MockProvider();

  const sent: { to: string; from: string; payload: SignalEnvelope }[] = [];

  const service = new SignalingService({
    selfPrivateKey: keyA.privateKey,
    selfPublicKey: keyA.publicKey,
    networkProviders: [mockProvider],
    sendRelay: (to, from, payload) => sent.push({ to, from, payload }),
    onNewConnection: () => {},
  });

  await service.initiate(keyB.publicKey);

  // Provider should have been instantiated
  assertEquals(mockProvider.instances.length, 1);

  // The driver should be an initiator
  const { driver } = mockProvider.instances[0];
  assert(driver.isInitiator);
  assert(driver.myToken !== undefined);

  // Now simulate the provider sending a signal
  driver.sendSignal('test-offer');

  // Wait for async encrypt
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, bin2hex(keyB.publicKey));
  assertEquals(sent[0].from, bin2hex(keyA.publicKey));
  assertEquals(sent[0].payload.signalIdx, 0);

  service.dispose();
});

Deno.test('SignalingService: recvSignal creates responder session and decrypts', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();
  const mockProvider = new MockProvider();

  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    networkProviders: [mockProvider],
    sendRelay: () => {},
    onNewConnection: () => {},
  });

  // Manually encrypt a signal as if A sent it
  const nonce = Hash.random().toBytes();
  const nonceHex = bin2hex(nonce);
  const sharedSecret = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const aesKey = await deriveAesKey(sharedSecret);
  const plaintext = new TextEncoder().encode('hello from A');
  const { encrypted, iv } = await encryptSignal(plaintext, aesKey);

  const envelope: SignalEnvelope = {
    signalingNonce: nonceHex,
    senderPublicKey: bin2hex(keyA.publicKey),
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: uint8ToBase64(encrypted),
    iv: uint8ToBase64(iv),
  };

  await serviceB.recvSignal(envelope);

  // Responder session should have been created
  assertEquals(mockProvider.instances.length, 1);
  const { driver } = mockProvider.instances[0];
  assert(!driver.isInitiator);

  serviceB.dispose();
});

Deno.test('SignalingService: duplicate signals are ignored', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  let recvCount = 0;
  const mockProvider: NetworkProvider = {
    providesProtocol: 'mock@test',
    createInstance: (driver: SignalingDriver): SignalingProvider => ({
      recvSignal: () => { recvCount++; },
    }),
  };

  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    networkProviders: [mockProvider],
    sendRelay: () => {},
    onNewConnection: () => {},
  });

  const nonce = Hash.random().toBytes();
  const sharedSecret = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const aesKey = await deriveAesKey(sharedSecret);
  const { encrypted, iv } = await encryptSignal(
    new TextEncoder().encode('signal-0'),
    aesKey,
  );

  const envelope: SignalEnvelope = {
    signalingNonce: bin2hex(nonce),
    senderPublicKey: bin2hex(keyA.publicKey),
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: uint8ToBase64(encrypted),
    iv: uint8ToBase64(iv),
  };

  await serviceB.recvSignal(envelope);
  await serviceB.recvSignal(envelope); // duplicate

  assertEquals(recvCount, 1, 'duplicate signal should be ignored');

  serviceB.dispose();
});

Deno.test('SignalingService: end-to-end two services exchange signals', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const providerA = new MockProvider();
  const providerB = new MockProvider();

  const sentByA: SignalEnvelope[] = [];
  const sentByB: SignalEnvelope[] = [];

  const serviceA = new SignalingService({
    selfPrivateKey: keyA.privateKey,
    selfPublicKey: keyA.publicKey,
    networkProviders: [providerA],
    sendRelay: (_to, _from, payload) => sentByA.push(payload),
    onNewConnection: () => {},
    retryIntervalMs: 10000, // large to avoid interference
  });

  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    networkProviders: [providerB],
    sendRelay: (_to, _from, payload) => sentByB.push(payload),
    onNewConnection: () => {},
    retryIntervalMs: 10000,
  });

  // A initiates
  await serviceA.initiate(keyB.publicKey);
  const driverA = providerA.instances[0].driver;

  // A sends a signal
  driverA.sendSignal('offer-from-A');
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(sentByA.length, 1);

  // Deliver A's signal to B
  await serviceB.recvSignal(sentByA[0]);

  // B should now have a responder session
  assertEquals(providerB.instances.length, 1);
  const driverB = providerB.instances[0].driver;

  // B sends a signal back
  driverB.sendSignal('answer-from-B');
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(sentByB.length, 1);

  // Deliver B's signal to A
  // B's signal has A's nonce (from the first envelope), so we need to
  // use the same nonce. The services handle this internally.
  await serviceA.recvSignal(sentByB[0]);

  serviceA.dispose();
  serviceB.dispose();
});

Deno.test('SignalingService: relay forwarding in NetworkBridge mock', () => {
  // Test signal routing logic directly
  const selfId = 'my-id';
  const signals: { to: string; from: string; payload: unknown }[] = [];

  // Simulate handleSignalMessage logic
  function handleSignalMessage(
    data: { to: string; from: string; payload: unknown },
    senderPeerId: string,
    peers: Map<string, { sendSignal: (to: string, from: string, p: unknown) => void }>,
  ) {
    if (data.to === selfId) {
      signals.push(data); // delivered locally
    } else {
      for (const [peerId, peer] of peers) {
        if (peerId !== senderPeerId) {
          peer.sendSignal(data.to, data.from, data.payload);
        }
      }
    }
  }

  const forwarded: { to: string; from: string }[] = [];
  const peers = new Map([
    ['peer-B', { sendSignal: (to: string, from: string, _p: unknown) => forwarded.push({ to, from }) }],
    ['peer-C', { sendSignal: (to: string, from: string, _p: unknown) => forwarded.push({ to, from }) }],
  ]);

  // Signal addressed to us
  handleSignalMessage({ to: selfId, from: 'peer-A', payload: {} }, 'peer-A', peers);
  assertEquals(signals.length, 1, 'should deliver locally');
  assertEquals(forwarded.length, 0, 'should not forward');

  // Signal addressed to someone else, from peer-B
  handleSignalMessage({ to: 'peer-X', from: 'peer-B', payload: {} }, 'peer-B', peers);
  assertEquals(signals.length, 1, 'should not deliver locally');
  assertEquals(forwarded.length, 1, 'should forward to peer-C only (not back to sender peer-B)');
  assertEquals(forwarded[0].to, 'peer-X');
});
