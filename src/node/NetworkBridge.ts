// Protocol spec: docs/protocol/transport.md
//
// Bridges the transport layer and the protocol stack. Owns a TransportManager,
// wires peer lifecycle into the routing/gossip modules, and relays encrypted
// signaling envelopes across the mesh.

import { Block, BlockStore } from '../core/Block.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { TransportManager } from './TransportManager.ts';
import { PeerConnection } from './PeerConnection.ts';
import { RoutingService } from './RoutingService.ts';
import { BlockAwareness, PushAction } from './RoutingModule.ts';
import { DeliveryTracker } from './DeliveryTracker.ts';
import { SignalEnvelope } from './SignalingService.ts';
import { TransportPlugin } from '../interfaces/transport.ts';
import { ScopedLogger } from '../core/EventLog.ts';

/** Simple set-based block awareness tracker. */
class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();

  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }

  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

export interface NetworkBridgeDeps {
  plugins: TransportPlugin[];
  selfPrivateKey: Uint8Array;
  selfPublicKey: Uint8Array;
  store: BlockStore;
  /**
   * Raw packet bytes keyed by block hash. NetworkBridge stashes inbound
   * packet bytes here and reads from it when forwarding so peers always
   * see the original signed wire bytes.
   */
  packetStore: Map<HashPrimitive, Uint8Array>;
  routing: RoutingService;
  processBlock: (block: Block, peerId: string) => void;
  selfId?: string;
  logger?: ScopedLogger;
}

/**
 * Bridges the transport layer and the protocol stack.
 *
 * Inbound:  TransportManager receives block -> processBlock(block, peerId)
 * Outbound: Gossip push actions -> TransportManager.sendBlock(block, [peer])
 * Lifecycle: Peer connect/disconnect -> gossip.addPeer/removePeer
 * Requests: Peer requests blocks -> look up in store and send back
 */
export class NetworkBridge {
  private readonly transport: TransportManager;
  private readonly routing: RoutingService;
  private readonly store: BlockStore;
  private readonly packetStore: Map<HashPrimitive, Uint8Array>;
  private readonly delivery: DeliveryTracker;
  private readonly selfId?: string;
  private readonly _log?: ScopedLogger;
  private readonly peerConnectedListeners: ((peerId: string) => void)[] = [];
  private readonly peerDisconnectedListeners: ((peerId: string) => void)[] = [];

  constructor(deps: NetworkBridgeDeps) {
    this.routing = deps.routing;
    this.store = deps.store;
    this.packetStore = deps.packetStore;
    this.delivery = new DeliveryTracker();
    this.selfId = deps.selfId;
    this._log = deps.logger;

    this.transport = new TransportManager({
      plugins: deps.plugins,
      selfPrivateKey: deps.selfPrivateKey,
      selfPublicKey: deps.selfPublicKey,
      callbacks: {
        onBlockReceived: (block, peerId, raw) => {
          this._log?.info('blockReceived', {
            hash: block.hash.toHex(),
            fromPeer: peerId,
          });
          // Stash raw packet bytes so this block can be re-emitted to
          // other peers and persisted to storage as-is.
          this.packetStore.set(block.hash.toPrimitive(), raw);
          deps.processBlock(block, peerId);
        },
        onPeerConnected: (peer) => {
          this.handlePeerConnected(peer);
        },
        onPeerDisconnected: (peerId) => {
          this.handlePeerDisconnected(peerId);
        },
      },
      sendRelay: (to, from, payload) => {
        this.broadcastSignalEnvelope(to, from, payload);
      },
      logger: deps.logger,
    });
  }

  /** Subscribe to peer-connected events (peerId = pubkey hex for authenticated peers). */
  onPeerConnected(cb: (peerId: string) => void): void {
    this.peerConnectedListeners.push(cb);
  }

  /** Subscribe to peer-disconnected events. */
  onPeerDisconnected(cb: (peerId: string) => void): void {
    this.peerDisconnectedListeners.push(cb);
  }

  /** Send a block directly to a specific peer by peerId. Used for manual seeding. */
  sendBlockToPeer(block: Block, peerId: string): void {
    const raw = this.packetStore.get(block.hash.toPrimitive());
    if (!raw) {
      this._log?.warn('sendBlockToPeerDropped', {
        hash: block.hash.toHex(),
        reason: 'no raw packet bytes in packetStore',
      });
      return;
    }
    this.transport.sendBlock(raw, [peerId]);
    this.delivery.markSent(block.hash, peerId);
  }

  /** Start all transport plugins. */
  start(): void {
    this.transport.start();
    this.transport.announceAddresses();
  }

  /** Connect to a bootstrap address via the plugin that accepts this protocol. */
  bootstrapConnection(protocol: string, address: string): void {
    this.transport.bootstrapConnection(protocol, address);
  }

  /** Initiate an authenticated handshake with a specific peer. */
  async connectToPeer(remotePublicKey: Uint8Array): Promise<void> {
    await this.transport.connectToPeer(remotePublicKey);
  }

  /** Handle gossip push actions -- send blocks to targeted peers. */
  handlePushActions(actions: PushAction[], block: Block): void {
    const raw = this.packetStore.get(block.hash.toPrimitive());
    if (!raw) {
      // Without raw bytes we can't forward without re-signing -- which we
      // can't do without the original signer's key. Drop and log.
      this._log?.warn('blockSendDropped', {
        hash: block.hash.toHex(),
        reason: 'no raw packet bytes in packetStore',
      });
      return;
    }
    for (const action of actions) {
      if (this.delivery.wasSent(block.hash, action.peer)) continue;
      this.transport.sendBlock(raw, [action.peer]);
      this.delivery.markSent(block.hash, action.peer);
      this.routing.reportPush(block.hash, action.peer);
      this._log?.debug('blockSent', {
        hash: block.hash.toHex(),
        toPeer: action.peer,
      });
    }
  }

  /** Read-only view of connected peers. */
  get peers(): ReadonlyMap<string, PeerConnection> {
    return this.transport.peers;
  }

  /** Shut down all connections and plugins. */
  async close(): Promise<void> {
    await this.transport.close();
  }

  // -- Internal ---------------------------------------------------------

  private handlePeerConnected(peer: PeerConnection): void {
    this._log?.info('peerConnected', { peerId: peer.peerId });
    this.routing.addPeer(peer.peerId, peer.peerId, new SetAwareness());
    for (const cb of this.peerConnectedListeners) cb(peer.peerId);

    peer.onRequest((data) => {
      for (const hashHex of data.hashes) {
        const hash = Hash.fromHex(hashHex);
        const raw = this.packetStore.get(hash.toPrimitive());
        if (raw) {
          peer.sendBlock(raw);
        }
      }
    });

    peer.onDelivery((data) => {
      if (data.delivered) {
        const hash = Hash.fromHex(data.hash);
        this.delivery.markDelivered(hash, peer.peerId);
        this.routing.reportDelivery(hash, peer.peerId, true);
      }
    });

    peer.onSignal((data) => {
      this.handleSignalMessage(data, peer.peerId);
    });
  }

  private handlePeerDisconnected(peerId: string): void {
    this._log?.info('peerDisconnected', { peerId });
    this.routing.removePeer(peerId);
    for (const cb of this.peerDisconnectedListeners) cb(peerId);
  }

  private handleSignalMessage(
    data: { to: string; from: string; payload: unknown },
    senderPeerId: string,
  ): void {
    if (this.selfId && data.to === this.selfId) {
      // Signal is for us -- deliver to transport manager's signaling
      void this.transport.recvSignalEnvelope(data.payload as SignalEnvelope);
    } else {
      // Forward to all connected peers except the sender
      for (const [peerId, peer] of this.transport.peers) {
        if (peerId !== senderPeerId) {
          peer.sendSignal(data.to, data.from, data.payload);
        }
      }
    }
  }

  /** Broadcast a signaling envelope to all connected peers. */
  private broadcastSignalEnvelope(
    to: string,
    from: string,
    payload: SignalEnvelope,
  ): void {
    for (const peer of this.transport.peers.values()) {
      peer.sendSignal(to, from, payload);
    }
  }
}
