// Protocol spec: docs/protocol/transport.md
//
// SignalingService owns the encrypted envelope wire format for authenticated
// transport handshakes. It does not know about plugins -- TransportManager
// wires session handles returned here into plugin lifecycles.

import { Hash } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import { secp } from '../util/secp.ts';
import {
  base64ToUint8,
  decryptSignal,
  deriveAesKey,
  encryptSignal,
  uint8ToBase64,
} from '../util/crypto.ts';
import { ScopedLogger } from '../core/EventLog.ts';

// -- Wire format --------------------------------------------------------

/** Encrypted signal envelope relayed through the mesh. */
export interface SignalEnvelope {
  signalingNonce: string;
  senderPublicKey: string;
  protocol: string;
  signalIdx: number;
  receivedIdxMask: string;
  encrypted: string;
  iv: string;
}

// -- Public handle ------------------------------------------------------

/** Handle for one authenticated handshake session. */
export interface SignalingSessionHandle {
  readonly remotePublicKey: Uint8Array;
  readonly protocol: string;
  readonly isInitiator: boolean;

  sendSignal(plaintext: string): void;
  onSignal(handler: (plaintext: string) => void): void;
  close(): void;
}

// -- Session state (internal) -------------------------------------------

interface PendingSignal {
  idx: number;
  envelope: SignalEnvelope;
}

interface SignalingSession {
  nonce: Uint8Array;
  nonceHex: string;
  remotePublicKey: Uint8Array;
  remotePublicKeyHex: string;
  protocol: string;
  isInitiator: boolean;
  aesKey: CryptoKey;
  nextEmitIdx: number;
  localReceivedMask: bigint;
  remoteReceivedMask: bigint;
  pending: PendingSignal[];
  retryTimer: ReturnType<typeof setInterval> | null;
  closed: boolean;
  signalHandler: ((plaintext: string) => void) | null;
  nextDeliverIdx: number;
  deliveryBuffer: Map<number, string>;
}

// -- Config -------------------------------------------------------------

export interface SignalingServiceConfig {
  selfPrivateKey: Uint8Array;
  selfPublicKey: Uint8Array;
  sendRelay: (to: string, from: string, payload: SignalEnvelope) => void;
  onInboundSession: (handle: SignalingSessionHandle, firstSignal: string) => void;
  retryIntervalMs?: number;
  logger?: ScopedLogger;
}

// -- Service ------------------------------------------------------------

export class SignalingService {
  private readonly sessions = new Map<string, SignalingSession>();
  private readonly config: SignalingServiceConfig;
  private readonly selfPublicKeyHex: string;

  constructor(config: SignalingServiceConfig) {
    this.config = config;
    this.selfPublicKeyHex = bin2hex(config.selfPublicKey);
  }

  /** Initiate a signaling session to a remote peer for a specific protocol. */
  async initiate(
    remotePublicKey: Uint8Array,
    protocol: string,
  ): Promise<SignalingSessionHandle> {
    const nonce = Hash.random().toBytes();
    const session = await this.createSession(nonce, remotePublicKey, protocol, true);
    return this.makeHandle(session);
  }

  /** Handle an inbound signal envelope from the relay network. */
  async recvSignal(envelope: SignalEnvelope): Promise<void> {
    let session = this.sessions.get(envelope.signalingNonce);
    let isNewResponder = false;

    if (!session) {
      const remotePublicKey = hexToBytes(envelope.senderPublicKey);
      const nonce = hexToBytes(envelope.signalingNonce);
      session = await this.createSession(nonce, remotePublicKey, envelope.protocol, false);
      isNewResponder = true;
    }

    if (session.closed) return;

    // Update remote's ACK state
    const remoteMask = BigInt('0x' + (envelope.receivedIdxMask || '0'));
    session.remoteReceivedMask |= remoteMask;
    session.pending = session.pending.filter(
      (p) => (session!.remoteReceivedMask & (1n << BigInt(p.idx))) === 0n,
    );

    // Skip duplicate signals
    const bit = 1n << BigInt(envelope.signalIdx);
    if (session.localReceivedMask & bit) {
      this.config.logger?.debug('duplicateSignalDropped', {
        nonce: envelope.signalingNonce,
        signalIdx: envelope.signalIdx,
      });
      return;
    }
    session.localReceivedMask |= bit;

    // Decrypt; drop envelopes that fail to decrypt (bad sender, stale session,
    // tampered payload). If this was a brand-new responder session, close it
    // -- it's an orphan.
    let signal: string;
    try {
      const encrypted = base64ToUint8(envelope.encrypted);
      const iv = base64ToUint8(envelope.iv);
      const plaintext = await decryptSignal(encrypted, iv, session.aesKey);
      signal = new TextDecoder().decode(plaintext);
    } catch {
      this.config.logger?.warn('signalDecryptFailed', {
        nonce: envelope.signalingNonce,
        senderPublicKey: envelope.senderPublicKey,
        signalIdx: envelope.signalIdx,
        isNewResponder,
      });
      if (isNewResponder) this.closeSession(session);
      return;
    }

    if (isNewResponder) {
      // The first signal (idx 0) is delivered as firstSignal; subsequent ones
      // go through the normal ordered-delivery path.
      session.nextDeliverIdx = envelope.signalIdx + 1;
      this.config.onInboundSession(this.makeHandle(session), signal);
    } else {
      session.deliveryBuffer.set(envelope.signalIdx, signal);
      this.drainBuffer(session);
    }
  }

  private drainBuffer(session: SignalingSession): void {
    while (session.deliveryBuffer.has(session.nextDeliverIdx)) {
      const next = session.deliveryBuffer.get(session.nextDeliverIdx)!;
      session.deliveryBuffer.delete(session.nextDeliverIdx);
      session.nextDeliverIdx += 1;
      session.signalHandler?.(next);
    }
  }

  /** Shut down all sessions. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      this.closeSession(session);
    }
    this.sessions.clear();
  }

  // -- Internal ---------------------------------------------------------

  private async createSession(
    nonce: Uint8Array,
    remotePublicKey: Uint8Array,
    protocol: string,
    isInitiator: boolean,
  ): Promise<SignalingSession> {
    const nonceHex = bin2hex(nonce);

    const sharedSecret = secp.getSharedSecret(this.config.selfPrivateKey, remotePublicKey);
    const aesKey = await deriveAesKey(sharedSecret);

    const remotePublicKeyHex = bin2hex(remotePublicKey);
    const retryMs = this.config.retryIntervalMs ?? 1000;

    const session: SignalingSession = {
      nonce,
      nonceHex,
      remotePublicKey,
      remotePublicKeyHex,
      protocol,
      isInitiator,
      aesKey,
      nextEmitIdx: 0,
      localReceivedMask: 0n,
      remoteReceivedMask: 0n,
      pending: [],
      retryTimer: null,
      closed: false,
      signalHandler: null,
      nextDeliverIdx: 0,
      deliveryBuffer: new Map(),
    };

    this.sessions.set(nonceHex, session);

    session.retryTimer = setInterval(() => {
      this.retryPending(session);
    }, retryMs);

    return session;
  }

  private makeHandle(session: SignalingSession): SignalingSessionHandle {
    return {
      remotePublicKey: session.remotePublicKey,
      protocol: session.protocol,
      isInitiator: session.isInitiator,
      sendSignal: (plaintext: string) => {
        this.sendSignalEncrypted(session, plaintext);
      },
      onSignal: (handler: (plaintext: string) => void) => {
        session.signalHandler = handler;
        this.drainBuffer(session);
      },
      close: () => {
        this.closeSession(session);
      },
    };
  }

  private sendSignalEncrypted(session: SignalingSession, signal: string): void {
    if (session.closed) return;

    const idx = session.nextEmitIdx++;
    const plaintext = new TextEncoder().encode(signal);

    encryptSignal(plaintext, session.aesKey).then(({ encrypted, iv }) => {
      const envelope: SignalEnvelope = {
        signalingNonce: session.nonceHex,
        senderPublicKey: this.selfPublicKeyHex,
        protocol: session.protocol,
        signalIdx: idx,
        receivedIdxMask: session.localReceivedMask.toString(16),
        encrypted: uint8ToBase64(encrypted),
        iv: uint8ToBase64(iv),
      };

      session.pending.push({ idx, envelope });

      this.config.sendRelay(
        session.remotePublicKeyHex,
        this.selfPublicKeyHex,
        envelope,
      );
    });
  }

  private retryPending(session: SignalingSession): void {
    if (session.closed) return;

    session.pending = session.pending.filter(
      (p) => (session.remoteReceivedMask & (1n << BigInt(p.idx))) === 0n,
    );

    if (session.pending.length === 0) return;

    for (const p of session.pending) {
      p.envelope.receivedIdxMask = session.localReceivedMask.toString(16);
      this.config.sendRelay(
        session.remotePublicKeyHex,
        this.selfPublicKeyHex,
        p.envelope,
      );
    }
  }

  private closeSession(session: SignalingSession): void {
    if (session.closed) return;
    session.closed = true;
    if (session.retryTimer !== null) {
      clearInterval(session.retryTimer);
      session.retryTimer = null;
    }
    this.sessions.delete(session.nonceHex);
  }
}

// -- Helpers ------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
