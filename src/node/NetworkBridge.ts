// Protocol spec: docs/protocol/transport.md
//
// Bridges the transport layer and the protocol stack. Owns a TransportManager,
// wires peer lifecycle into the routing/gossip modules, and relays encrypted
// signaling envelopes across the mesh.

import { Block, BlockStore } from '../core/Block.ts';
import { Hash } from '../util/Hash.ts';
import { TransportManager } from './TransportManager.ts';
import { BlockSerializer, createDefaultBlockSerializer, PeerConnection } from './PeerConnection.ts';
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
  routing: RoutingService;
  processBlock: (block: Block, peerId: string) => void;
  serializer?: BlockSerializer;
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
  private readonly delivery: DeliveryTracker;
  private readonly selfId?: string;
  private readonly _log?: ScopedLogger;

  constructor(deps: NetworkBridgeDeps) {
    this.routing = deps.routing;
    this.store = deps.store;
    this.delivery = new DeliveryTracker();
    this.selfId = deps.selfId;
    this._log = deps.logger;

    this.transport = new TransportManager({
      plugins: deps.plugins,
      selfPrivateKey: deps.selfPrivateKey,
      selfPublicKey: deps.selfPublicKey,
      callbacks: {
        onBlockReceived: (block, peerId) => {
          this._log?.info('blockReceived', {
            hash: block.hash.toHex(),
            fromPeer: peerId,
          });
          deps.processBlock(block, peerId);
        },
        onPeerConnected: (peer) => {
          this.handlePeerConnected(peer);
        },
        onPeerDisconnected: (peerId) => {
          this.handlePeerDisconnected(peerId);
        },
      },
      serializer: deps.serializer ?? createDefaultBlockSerializer(),
      sendRelay: (to, from, payload) => {
        this.broadcastSignalEnvelope(to, from, payload);
      },
      logger: deps.logger,
    });
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
    for (const action of actions) {
      if (this.delivery.wasSent(block.hash, action.peer)) continue;
      this.transport.sendBlock(block, [action.peer]);
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

    peer.onRequest((data) => {
      for (const hashHex of data.hashes) {
        const hash = Hash.fromHex(hashHex);
        const block = this.store.get(hash);
        if (block) {
          peer.sendBlock(block);
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
