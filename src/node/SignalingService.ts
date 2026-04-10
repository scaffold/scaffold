import { Hash } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import { secp } from '../util/secp.ts';
import { deriveAesKey, decryptSignal, encryptSignal, uint8ToBase64, base64ToUint8 } from '../util/crypto.ts';
import {
  ConnectionDriver,
  ConnectionProvider,
  NetworkProvider,
  SignalingDriver,
  SignalingProvider,
} from '../interfaces/network.ts';
import { TransportConnection } from './PeerConnection.ts';

// -- Wire format --------------------------------------------------------

/** Encrypted signal envelope sent over the relay network. */
export interface SignalEnvelope {
  signalingNonce: string;
  senderPublicKey: string;
  signalIdx: number;
  receivedIdxMask: string;
  encrypted: string;
  iv: string;
}

// -- Session state ------------------------------------------------------

interface PendingSignal {
  idx: number;
  envelope: SignalEnvelope;
}

interface SignalingSession {
  nonce: Uint8Array;
  nonceHex: string;
  remotePublicKey: Uint8Array;
  remotePublicKeyHex: string;
  isInitiator: boolean;
  aesKey: CryptoKey;
  myToken: Hash;
  provider: SignalingProvider;
  nextEmitIdx: number;
  localReceivedMask: bigint;
  remoteReceivedMask: bigint;
  pending: PendingSignal[];
  retryTimer: ReturnType<typeof setInterval> | null;
  closed: boolean;
}

// -- Config -------------------------------------------------------------

export interface SignalingServiceConfig {
  selfPrivateKey: Uint8Array;
  selfPublicKey: Uint8Array;
  networkProviders: NetworkProvider[];
  sendRelay: (to: string, from: string, payload: SignalEnvelope) => void;
  onNewConnection: (transport: TransportConnection) => void;
  retryIntervalMs?: number;
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

  /** Initiate a signaling session to a remote peer. */
  async initiate(remotePublicKey: Uint8Array): Promise<void> {
    const nonce = Hash.random().toBytes();
    await this.createSession(nonce, remotePublicKey, true);
  }

  /** Handle an inbound signal envelope from the relay network. */
  async recvSignal(envelope: SignalEnvelope): Promise<void> {
    let session = this.sessions.get(envelope.signalingNonce);

    if (!session) {
      // Create responder session
      const remotePublicKey = hexToBytes(envelope.senderPublicKey);
      const nonce = hexToBytes(envelope.signalingNonce);
      session = await this.createSession(nonce, remotePublicKey, false);
    }

    if (session.closed) return;

    // Update remote's ACK state -- prune acknowledged signals from retry queue
    const remoteMask = BigInt('0x' + (envelope.receivedIdxMask || '0'));
    session.remoteReceivedMask |= remoteMask;
    session.pending = session.pending.filter(
      (p) => (session!.remoteReceivedMask & (1n << BigInt(p.idx))) === 0n,
    );

    // Skip duplicate signals
    const bit = 1n << BigInt(envelope.signalIdx);
    if (session.localReceivedMask & bit) return;
    session.localReceivedMask |= bit;

    // Decrypt and deliver
    const encrypted = base64ToUint8(envelope.encrypted);
    const iv = base64ToUint8(envelope.iv);
    const plaintext = await decryptSignal(encrypted, iv, session.aesKey);
    const signal = new TextDecoder().decode(plaintext);

    session.provider.recvSignal(signal, envelope.signalIdx);
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
    isInitiator: boolean,
  ): Promise<SignalingSession> {
    const nonceHex = bin2hex(nonce);

    // Derive crypto material
    const sharedSecret = secp.getSharedSecret(this.config.selfPrivateKey, remotePublicKey);
    const aesKey = await deriveAesKey(sharedSecret);
    const myToken = Hash.digestParts(
      this.config.selfPublicKey,
      sharedSecret,
      nonce,
    );

    // Find a matching network provider
    const provider = this.config.networkProviders[0];
    if (!provider) {
      throw new Error('No network providers available');
    }

    const remotePublicKeyHex = bin2hex(remotePublicKey);
    const retryMs = this.config.retryIntervalMs ?? 1000;

    const session: SignalingSession = {
      nonce,
      nonceHex,
      remotePublicKey,
      remotePublicKeyHex,
      isInitiator,
      aesKey,
      myToken,
      provider: null!, // set below
      nextEmitIdx: 0,
      localReceivedMask: 0n,
      remoteReceivedMask: 0n,
      pending: [],
      retryTimer: null,
      closed: false,
    };

    this.sessions.set(nonceHex, session);

    // Build the SignalingDriver for the NetworkProvider
    const driver: SignalingDriver = {
      ctx: null,
      protocol: provider.providesProtocol,
      isInitiator,
      myToken,

      sendSignal: (signal: string, _priority?: number) => {
        this.sendSignalEncrypted(session, signal);
      },

      createConnection: (
        remoteToken: Hash | undefined,
        conn: ConnectionProvider,
      ): ConnectionDriver => {
        return this.handleConnection(session, remoteToken, conn);
      },
    };

    session.provider = provider.createInstance(driver);

    // Start retry timer
    session.retryTimer = setInterval(() => {
      this.retryPending(session);
    }, retryMs);

    return session;
  }

  private sendSignalEncrypted(session: SignalingSession, signal: string): void {
    if (session.closed) return;

    const idx = session.nextEmitIdx++;
    const plaintext = new TextEncoder().encode(signal);

    // Encrypt and send (async, fire-and-forget)
    encryptSignal(plaintext, session.aesKey).then(({ encrypted, iv }) => {
      const envelope: SignalEnvelope = {
        signalingNonce: session.nonceHex,
        senderPublicKey: this.selfPublicKeyHex,
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

    // Prune acknowledged signals
    session.pending = session.pending.filter(
      (p) => (session.remoteReceivedMask & (1n << BigInt(p.idx))) === 0n,
    );

    if (session.pending.length === 0) return;

    for (const p of session.pending) {
      // Update the ACK mask in the envelope before resending
      p.envelope.receivedIdxMask = session.localReceivedMask.toString(16);

      this.config.sendRelay(
        session.remotePublicKeyHex,
        this.selfPublicKeyHex,
        p.envelope,
      );
    }
  }

  private handleConnection(
    session: SignalingSession,
    remoteToken: Hash | undefined,
    conn: ConnectionProvider,
  ): ConnectionDriver {
    // Validate remote token
    const sharedSecret = secp.getSharedSecret(
      this.config.selfPrivateKey,
      session.remotePublicKey,
    );
    const expectedToken = Hash.digestParts(
      session.remotePublicKey,
      sharedSecret,
      session.nonce,
    );

    if (!remoteToken || !Hash.equals(remoteToken, expectedToken)) {
      conn.shutdown();
      return { recvData: () => {}, close: () => {} };
    }

    // Wrap ConnectionProvider as TransportConnection
    const transport = createTransportAdapter(
      session.remotePublicKeyHex,
      conn,
    );

    this.config.onNewConnection(transport);
    this.closeSession(session);

    return transport._driver;
  }

  private closeSession(session: SignalingSession): void {
    if (session.closed) return;
    session.closed = true;
    if (session.retryTimer !== null) {
      clearInterval(session.retryTimer);
      session.retryTimer = null;
    }
    session.provider?.dispose?.();
    this.sessions.delete(session.nonceHex);
  }
}

// -- Transport adapter --------------------------------------------------

interface TransportAdapter extends TransportConnection {
  _driver: ConnectionDriver;
}

/**
 * Wraps a byte-level ConnectionProvider into the string-level
 * TransportConnection that PeerConnection expects.
 */
function createTransportAdapter(
  peerId: string,
  conn: ConnectionProvider,
): TransportAdapter {
  let messageHandler: ((data: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const driver: ConnectionDriver = {
    recvData: (data: Uint8Array) => {
      const str = new TextDecoder().decode(data);
      messageHandler?.(str);
    },
    close: () => {
      closeHandler?.();
    },
  };

  return {
    peerId,
    _driver: driver,
    send: (data: string) => {
      conn.sendReliable(new TextEncoder().encode(data));
    },
    onMessage: (handler: (data: string) => void) => {
      messageHandler = handler;
    },
    onClose: (handler: () => void) => {
      closeHandler = handler;
    },
    close: () => {
      conn.shutdown();
    },
  };
}

// -- Hex helper ---------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
