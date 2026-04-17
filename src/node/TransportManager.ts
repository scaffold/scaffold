// Protocol spec: docs/protocol/transport.md
//
// TransportManager owns the plugin lifecycle, routes bootstrap requests to
// the right plugin, orchestrates authenticated handshakes via SignalingService,
// and produces PeerConnections for both anonymous and authenticated peers.

import { Block } from '../core/Block.ts';
import { bin2hex } from '../util/hex.ts';
import { ScopedLogger } from '../core/EventLog.ts';
import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../interfaces/transport.ts';
import { PeerConnection, TransportConnection } from './PeerConnection.ts';
import { SignalEnvelope, SignalingService, SignalingSessionHandle } from './SignalingService.ts';

// -- Callbacks ---------------------------------------------------------

type BlockReceivedHandler = (block: Block, peerId: string, raw: Uint8Array) => void;

export interface TransportManagerCallbacks {
  onBlockReceived: BlockReceivedHandler;
  onPeerConnected?: (peer: PeerConnection) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onAddressAnnounced?: (protocol: string, address: string) => void;
}

export interface TransportManagerDeps {
  plugins: TransportPlugin[];
  selfPrivateKey: Uint8Array;
  selfPublicKey: Uint8Array;
  callbacks: TransportManagerCallbacks;
  sendRelay: (to: string, from: string, payload: SignalEnvelope) => void;
  logger?: ScopedLogger;
}

// -- Manager -----------------------------------------------------------

export class TransportManager {
  private readonly _peers = new Map<string, PeerConnection>();
  private readonly services = new Map<TransportPlugin, TransportService>();
  private readonly deps: TransportManagerDeps;
  private signaling?: SignalingService;
  private started = false;

  constructor(deps: TransportManagerDeps) {
    this.deps = deps;
  }

  get peers(): ReadonlyMap<string, PeerConnection> {
    return this._peers;
  }

  /** Start all plugins and initialize signaling if any plugin supports authenticated transport. */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.hasAuthenticatedCapability()) {
      this.signaling = new SignalingService({
        selfPrivateKey: this.deps.selfPrivateKey,
        selfPublicKey: this.deps.selfPublicKey,
        sendRelay: this.deps.sendRelay,
        onInboundSession: (handle, firstSignal) => {
          this.handleInboundSession(handle, firstSignal);
        },
        logger: this.deps.logger?.child('signaling'),
      });
    }

    for (const plugin of this.deps.plugins) {
      const anonymousDriver = this.makeAnonymousDriver();
      const service = plugin.start(anonymousDriver);
      this.services.set(plugin, service);
    }
  }

  /** Ask every plugin that can to announce its reachable addresses. */
  announceAddresses(): void {
    for (const service of this.services.values()) {
      service.announceAddresses?.();
    }
  }

  /** Dial a specific bootstrap address through the plugin that accepts this protocol. */
  bootstrapConnection(protocol: string, address: string): void {
    const plugin = this.deps.plugins.find((p) => p.acceptsProtocols.includes(protocol));
    if (!plugin) {
      throw new Error(`No plugin accepts protocol: ${protocol}`);
    }
    const service = this.services.get(plugin);
    if (!service?.dialAddress) {
      throw new Error(`Plugin for protocol "${protocol}" does not support dialAddress`);
    }
    service.dialAddress(address);
  }

  /** Initiate an authenticated handshake with a peer identified by their public key. */
  async connectToPeer(remotePublicKey: Uint8Array): Promise<void> {
    if (!this.signaling) {
      throw new Error('No authenticated transport available');
    }
    const plugin = this.pickAuthenticatedInitiatorPlugin();
    if (!plugin) {
      throw new Error('No plugin supports authenticated transport as initiator');
    }
    const protocol = plugin.emitsProtocol!;
    const handle = await this.signaling.initiate(remotePublicKey, protocol);
    this.startPluginSession(plugin, handle);
  }

  /** Deliver an inbound signaling envelope (received over the mesh). */
  async recvSignalEnvelope(envelope: SignalEnvelope): Promise<void> {
    await this.signaling?.recvSignal(envelope);
  }

  /** Broadcast or target a raw block packet to connected peers. */
  sendBlock(raw: Uint8Array, targets?: string[]): void {
    if (targets && targets.length > 0) {
      for (const id of targets) {
        this._peers.get(id)?.sendBlock(raw);
      }
    } else {
      for (const peer of this._peers.values()) {
        peer.sendBlock(raw);
      }
    }
  }

  /** Shut down all services and connections. */
  async close(): Promise<void> {
    for (const peer of this._peers.values()) {
      peer.close();
    }
    this._peers.clear();

    const stops: Promise<void>[] = [];
    for (const service of this.services.values()) {
      stops.push(service.stop());
    }
    await Promise.all(stops);
    this.services.clear();

    this.signaling?.dispose();
  }

  // -- Internal -------------------------------------------------------

  private hasAuthenticatedCapability(): boolean {
    return this.deps.plugins.some((p) => p.emitsProtocol !== undefined);
  }

  private pickAuthenticatedInitiatorPlugin(): TransportPlugin | undefined {
    return this.deps.plugins.find((p) => {
      const service = this.services.get(p);
      return p.emitsProtocol !== undefined &&
        service?.initializeAuthenticatedTransport !== undefined;
    });
  }

  private makeAnonymousDriver(): AnonymousTransportDriver {
    return {
      broadcastAddress: (signal: string) => {
        this.deps.logger?.info('addressAnnounced', { signal });
        // Protocol of the broadcast isn't known here -- callers that care can
        // derive it from the signal format. For now just log.
        this.deps.callbacks.onAddressAnnounced?.('', signal);
      },
      createAnonymousConnection: (conn: ConnectionProvider): ConnectionDriver => {
        const peerId = `anon:${crypto.randomUUID().slice(0, 8)}`;
        return this.registerConnection(peerId, conn);
      },
    };
  }

  private handleInboundSession(
    handle: SignalingSessionHandle,
    firstSignal: string,
  ): void {
    const plugin = this.deps.plugins.find((p) =>
      p.acceptsProtocols.includes(handle.protocol) &&
      this.services.get(p)?.initializeAuthenticatedTransport !== undefined
    );
    if (!plugin) {
      this.deps.logger?.warn('inboundSessionRejected', {
        protocol: handle.protocol,
        reason: 'no plugin accepts this protocol',
      });
      handle.close();
      return;
    }
    const session = this.startPluginSession(plugin, handle);
    session.recvSignal(firstSignal);
  }

  private startPluginSession(
    plugin: TransportPlugin,
    handle: SignalingSessionHandle,
  ): TransportSession {
    const service = this.services.get(plugin)!;
    const driver = this.makeAuthenticatedDriver(handle, () => {
      // When connection is produced, close the signaling and plugin session
      handle.close();
    });
    const session = service.initializeAuthenticatedTransport!(driver);
    handle.onSignal((plaintext) => session.recvSignal(plaintext));
    return session;
  }

  private makeAuthenticatedDriver(
    handle: SignalingSessionHandle,
    onConnected: () => void,
  ): AuthenticatedTransportDriver {
    return {
      sendSignal: (plaintext: string) => handle.sendSignal(plaintext),
      createAuthenticatedConnection: (conn: ConnectionProvider): ConnectionDriver => {
        const peerId = bin2hex(handle.remotePublicKey);
        const driver = this.registerConnection(peerId, conn);
        onConnected();
        return driver;
      },
    };
  }

  private registerConnection(peerId: string, conn: ConnectionProvider): ConnectionDriver {
    const { transport, driver } = wrapConnection(peerId, conn);
    const peer = new PeerConnection(transport, this.deps.callbacks.onBlockReceived);
    this._peers.set(peer.peerId, peer);
    this.deps.callbacks.onPeerConnected?.(peer);
    peer.onClose(() => {
      this._peers.delete(peer.peerId);
      this.deps.callbacks.onPeerDisconnected?.(peer.peerId);
    });
    return driver;
  }
}

// -- Adapter: ConnectionProvider -> TransportConnection ----------------

/**
 * Adapter that exposes a plugin's byte-level ConnectionProvider as the
 * byte-level TransportConnection PeerConnection consumes.
 */
export function wrapConnection(
  peerId: string,
  conn: ConnectionProvider,
): { transport: TransportConnection; driver: ConnectionDriver } {
  let messageHandler: ((data: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;

  const driver: ConnectionDriver = {
    recvData: (data: Uint8Array) => {
      messageHandler?.(data);
    },
    close: () => {
      closeHandler?.();
    },
  };

  const transport: TransportConnection = {
    peerId,
    send: (data: Uint8Array) => {
      conn.sendReliable(data);
    },
    onMessage: (handler: (data: Uint8Array) => void) => {
      messageHandler = handler;
    },
    onClose: (handler: () => void) => {
      closeHandler = handler;
    },
    close: () => {
      conn.shutdown();
    },
  };

  return { transport, driver };
}
