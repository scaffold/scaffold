import { assert, assertEquals } from '@std/assert';
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
  SignalEnvelope,
  SignalingService,
  SignalingSessionHandle,
} from '../src/node/SignalingService.ts';

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

// -- SignalingService tests ----------------------------------------------

Deno.test('SignalingService: initiate creates a session and sends a signal', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const sent: { to: string; from: string; payload: SignalEnvelope }[] = [];

  const service = new SignalingService({
    selfPrivateKey: keyA.privateKey,
    selfPublicKey: keyA.publicKey,
    sendRelay: (to, from, payload) => sent.push({ to, from, payload }),
    onInboundSession: () => {},
  });

  const handle = await service.initiate(keyB.publicKey, 'test');
  assert(handle.isInitiator);
  assertEquals(handle.protocol, 'test');

  handle.sendSignal('test-offer');
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, bin2hex(keyB.publicKey));
  assertEquals(sent[0].from, bin2hex(keyA.publicKey));
  assertEquals(sent[0].payload.signalIdx, 0);
  assertEquals(sent[0].payload.protocol, 'test');

  service.dispose();
});

Deno.test('SignalingService: recvSignal creates responder session and decrypts', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const received: { handle: SignalingSessionHandle; firstSignal: string }[] = [];

  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    sendRelay: () => {},
    onInboundSession: (handle, signal) => {
      received.push({ handle, firstSignal: signal });
    },
  });

  // Construct what A would have sent
  const nonce = Hash.random().toBytes();
  const sharedSecret = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const aesKey = await deriveAesKey(sharedSecret);
  const plaintext = new TextEncoder().encode('hello from A');
  const { encrypted, iv } = await encryptSignal(plaintext, aesKey);

  const envelope: SignalEnvelope = {
    signalingNonce: bin2hex(nonce),
    senderPublicKey: bin2hex(keyA.publicKey),
    protocol: 'mock',
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: uint8ToBase64(encrypted),
    iv: uint8ToBase64(iv),
  };

  await serviceB.recvSignal(envelope);

  assertEquals(received.length, 1);
  assert(!received[0].handle.isInitiator);
  assertEquals(received[0].handle.protocol, 'mock');
  assertEquals(received[0].firstSignal, 'hello from A');

  serviceB.dispose();
});

Deno.test('SignalingService: duplicate signals are ignored', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  let inboundCount = 0;
  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    sendRelay: () => {},
    onInboundSession: () => {
      inboundCount++;
    },
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
    protocol: 'mock',
    signalIdx: 0,
    receivedIdxMask: '0',
    encrypted: uint8ToBase64(encrypted),
    iv: uint8ToBase64(iv),
  };

  await serviceB.recvSignal(envelope);
  await serviceB.recvSignal(envelope); // duplicate

  assertEquals(inboundCount, 1, 'duplicate signal should not create a new session');

  serviceB.dispose();
});

Deno.test('SignalingService: signals from initiator are delivered in order to handler', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const received: string[] = [];
  let handle: SignalingSessionHandle | null = null;

  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    sendRelay: () => {},
    onInboundSession: (h) => {
      handle = h;
      h.onSignal((plaintext) => received.push(plaintext));
    },
  });

  const nonce = Hash.random().toBytes();
  const sharedSecret = secp.getSharedSecret(keyA.privateKey, keyB.publicKey);
  const aesKey = await deriveAesKey(sharedSecret);

  async function makeEnvelope(plaintext: string, idx: number): Promise<SignalEnvelope> {
    const { encrypted, iv } = await encryptSignal(
      new TextEncoder().encode(plaintext),
      aesKey,
    );
    return {
      signalingNonce: bin2hex(nonce),
      senderPublicKey: bin2hex(keyA.publicKey),
      protocol: 'mock',
      signalIdx: idx,
      receivedIdxMask: '0',
      encrypted: uint8ToBase64(encrypted),
      iv: uint8ToBase64(iv),
    };
  }

  // Establish session with first signal
  await serviceB.recvSignal(await makeEnvelope('msg-0', 0));
  assert(handle !== null);

  // Deliver signals 2 then 1 (out of order); handler should see them in order 1, 2
  await serviceB.recvSignal(await makeEnvelope('msg-2', 2));
  assertEquals(received.length, 0, 'signal 2 should be buffered until 1 arrives');

  await serviceB.recvSignal(await makeEnvelope('msg-1', 1));
  assertEquals(received, ['msg-1', 'msg-2']);

  serviceB.dispose();
});

Deno.test('SignalingService: end-to-end two services exchange signals', async () => {
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  const sentByA: SignalEnvelope[] = [];
  const sentByB: SignalEnvelope[] = [];

  const bInbound: { handle: SignalingSessionHandle; firstSignal: string }[] = [];

  const serviceA = new SignalingService({
    selfPrivateKey: keyA.privateKey,
    selfPublicKey: keyA.publicKey,
    sendRelay: (_to, _from, payload) => sentByA.push(payload),
    onInboundSession: () => {},
    retryIntervalMs: 10000,
  });

  const serviceB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    sendRelay: (_to, _from, payload) => sentByB.push(payload),
    onInboundSession: (handle, firstSignal) => {
      bInbound.push({ handle, firstSignal });
    },
    retryIntervalMs: 10000,
  });

  const handleA = await serviceA.initiate(keyB.publicKey, 'mock');
  handleA.sendSignal('offer-from-A');
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(sentByA.length, 1);

  await serviceB.recvSignal(sentByA[0]);
  assertEquals(bInbound.length, 1);
  assertEquals(bInbound[0].firstSignal, 'offer-from-A');

  bInbound[0].handle.sendSignal('answer-from-B');
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(sentByB.length, 1);

  const receivedAtA: string[] = [];
  handleA.onSignal((s) => receivedAtA.push(s));

  await serviceA.recvSignal(sentByB[0]);
  assertEquals(receivedAtA, ['answer-from-B']);

  serviceA.dispose();
  serviceB.dispose();
});

Deno.test('SignalingService: duplicate inbound envelope after close does not spawn a second session', async () => {
  // Regression test for the handshake storm: the mesh relay bounces
  // the initial envelope through multiple paths back to the responder.
  // If the responder deletes its session on close, each echo looks like
  // a brand-new handshake and spawns a fresh responder session -- which
  // in the WS-client plugin means a fresh dial to the server for every
  // echo, creating an unbounded stream of anonymous connections.
  const keyA = generateKeyPair();
  const keyB = generateKeyPair();

  let initiatorEnvelope: SignalEnvelope | null = null;
  const sigA = new SignalingService({
    selfPrivateKey: keyA.privateKey,
    selfPublicKey: keyA.publicKey,
    sendRelay: (_to, _from, payload) => {
      initiatorEnvelope ??= payload;
    },
    onInboundSession: () => {
      throw new Error('A should not receive inbound sessions in this test');
    },
  });

  let inboundCount = 0;
  const sigB = new SignalingService({
    selfPrivateKey: keyB.privateKey,
    selfPublicKey: keyB.publicKey,
    sendRelay: () => {},
    onInboundSession: (handle) => {
      inboundCount++;
      // Simulate the normal lifecycle: once the transport-level handshake
      // completes, the signaling session is closed.
      handle.close();
    },
  });

  const handle = await sigA.initiate(keyB.publicKey, 'websocket');
  handle.sendSignal('hello');

  // Wait for the async encrypt so the captured envelope is populated.
  await new Promise((r) => setTimeout(r, 10));
  assert(initiatorEnvelope, 'expected sendRelay to fire');

  // First delivery: creates B's responder session, then B closes it.
  await sigB.recvSignal(initiatorEnvelope);

  // Simulated mesh echoes of the same envelope. None may spawn new sessions.
  await sigB.recvSignal(initiatorEnvelope);
  await sigB.recvSignal(initiatorEnvelope);
  await sigB.recvSignal(initiatorEnvelope);

  assertEquals(
    inboundCount,
    1,
    'duplicate envelopes after session close must not create new responder sessions',
  );

  sigA.dispose();
  sigB.dispose();
});
