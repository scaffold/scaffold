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

type BlockReceivedHandler = (block: Block, peerId: string) => void;

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
  // Primary store: every active PeerConnection, keyed by a unique
  // connection id. Multiple entries may share the same logical
  // `peer.peerId` (pubkey hex / `anon:xxx`); duplicate connections to
  // the same peer are explicitly allowed -- abuse is bounded by future
  // utility-based eviction, not by pubkey uniqueness here.
  private readonly _peers = new Map<string, PeerConnection>();
  // Secondary index: logical peerId -> set of connection ids. Lets
  // callers that think in logical peers (sendBlock targets, routing)
  // fan out to every active physical connection.
  private readonly _byPeerId = new Map<string, Set<string>>();
  private readonly services = new Map<TransportPlugin, TransportService>();
  private readonly deps: TransportManagerDeps;
  private signaling?: SignalingService;
  private started = false;

  constructor(deps: TransportManagerDeps) {
    this.deps = deps;
  }

  /** All active connections, keyed by unique connection id. */
  get peers(): ReadonlyMap<string, PeerConnection> {
    return this._peers;
  }

  /** Live connections sharing a logical peerId. May be empty. */
  connectionsByPeerId(peerId: string): PeerConnection[] {
    const ids = this._byPeerId.get(peerId);
    if (!ids || ids.size === 0) return [];
    const out: PeerConnection[] = [];
    for (const id of ids) {
      const peer = this._peers.get(id);
      if (peer) out.push(peer);
    }
    return out;
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

  /**
   * Broadcast or target a raw block packet to connected peers. Each
   * `target` is matched first against connection ids, then against
   * logical peerIds -- a logical-peerId target fans out to every active
   * connection sharing that peerId.
   */
  sendBlock(raw: Uint8Array, targets?: string[]): void {
    if (targets && targets.length > 0) {
      for (const id of targets) {
        const direct = this._peers.get(id);
        if (direct) {
          direct.sendBlock(raw);
          continue;
        }
        for (const peer of this.connectionsByPeerId(id)) {
          peer.sendBlock(raw);
        }
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
    this._byPeerId.clear();

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
    // Signaling is needed whenever a plugin can participate in an
    // authenticated handshake in either direction: initiate (emitsProtocol)
    // or accept (acceptsProtocols). A client-only plugin still needs
    // signaling to decrypt inbound handshake envelopes.
    return this.deps.plugins.some(
      (p) => p.emitsProtocol !== undefined || p.acceptsProtocols.length > 0,
    );
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
    const connectionId = `${peerId}#${crypto.randomUUID().slice(0, 8)}`;
    const { transport, driver } = wrapConnection(peerId, conn);
    const peer = new PeerConnection(transport, this.deps.callbacks.onBlockReceived);
    this._peers.set(connectionId, peer);
    let group = this._byPeerId.get(peerId);
    if (!group) {
      group = new Set();
      this._byPeerId.set(peerId, group);
    }
    const isFirstConnection = group.size === 0;
    group.add(connectionId);
    // Fire onPeerConnected only on the first connection to a logical
    // peerId so RoutingModule / UI counters see one peer per pubkey,
    // even when the transport holds multiple physical sessions.
    if (isFirstConnection) {
      this.deps.callbacks.onPeerConnected?.(peer);
    }
    peer.onClose(() => {
      this._peers.delete(connectionId);
      const g = this._byPeerId.get(peerId);
      if (g) {
        g.delete(connectionId);
        if (g.size === 0) {
          this._byPeerId.delete(peerId);
          this.deps.callbacks.onPeerDisconnected?.(peerId);
        }
      }
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
