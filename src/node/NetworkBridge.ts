import { Block, BlockStore } from '../core/Block.ts';
import { Hash } from '../util/Hash.ts';
import { NetworkManager, NetworkPlugin } from './NetworkManager.ts';
import { BlockSerializer, createDefaultBlockSerializer, PeerConnection } from './PeerConnection.ts';
import { RoutingService } from './RoutingService.ts';
import { BlockAwareness, PushAction } from './RoutingModule.ts';
import { DeliveryTracker } from './DeliveryTracker.ts';
import { SignalingService, SignalEnvelope } from './SignalingService.ts';
import { TransportConnection } from './PeerConnection.ts';
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
  plugins: NetworkPlugin[];
  store: BlockStore;
  routing: RoutingService;
  processBlock: (block: Block, peerId: string) => void;
  serializer?: BlockSerializer;
  signalingService?: SignalingService;
  selfId?: string;
  logger?: ScopedLogger;
}

/**
 * Bridges the network layer and the protocol stack.
 *
 * Inbound:  NetworkManager receives block -> processBlock(block, peerId)
 * Outbound: Gossip push actions -> NetworkManager.sendBlock(block, [peer])
 * Lifecycle: Peer connect/disconnect -> gossip.addPeer/removePeer
 * Requests: Peer requests blocks -> look up in store and send back
 */
export class NetworkBridge {
  private readonly network: NetworkManager;
  private readonly routing: RoutingService;
  private readonly store: BlockStore;
  private readonly delivery: DeliveryTracker;
  private readonly signalingService?: SignalingService;
  private readonly selfId?: string;
  private readonly _log?: ScopedLogger;

  constructor(deps: NetworkBridgeDeps) {
    this.routing = deps.routing;
    this.store = deps.store;
    this.delivery = new DeliveryTracker();
    this.signalingService = deps.signalingService;
    this.selfId = deps.selfId;
    this._log = deps.logger;

    this.network = new NetworkManager(
      deps.plugins,
      {
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
      deps.serializer ?? createDefaultBlockSerializer(),
    );
  }

  /** Start all network plugins. */
  start(): void {
    this.network.start();
  }

  /** Connect to bootstrap addresses. */
  bootstrap(addresses: string[]): void {
    this.network.bootstrap(addresses);
  }

  /** Handle gossip push actions -- send blocks to targeted peers. */
  handlePushActions(actions: PushAction[], block: Block): void {
    for (const action of actions) {
      if (this.delivery.wasSent(block.hash, action.peer)) continue;
      this.network.sendBlock(block, [action.peer]);
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
    return this.network.peers;
  }

  /** Shut down all connections and plugins. */
  close(): void {
    this.network.close();
  }

  // -- Internal ---------------------------------------------------------

  private handlePeerConnected(peer: PeerConnection): void {
    this._log?.info('peerConnected', { peerId: peer.peerId });
    // Register peer with gossip (using peerId as pubkey placeholder)
    this.routing.addPeer(peer.peerId, peer.peerId, new SetAwareness());

    // Register message handlers on the peer
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
      // Signal is for us -- deliver to signaling service
      this.signalingService?.recvSignal(data.payload as SignalEnvelope);
    } else {
      // Forward to all connected peers except the sender
      for (const [peerId, peer] of this.network.peers) {
        if (peerId !== senderPeerId) {
          peer.sendSignal(data.to, data.from, data.payload);
        }
      }
    }
  }

  /** Broadcast a signal to all connected peers (used by SignalingService). */
  broadcastSignal(to: string, from: string, payload: SignalEnvelope): void {
    for (const peer of this.network.peers.values()) {
      peer.sendSignal(to, from, payload);
    }
  }

  /** Register an externally-established connection (e.g. from WebRTC signaling). */
  addConnection(transport: TransportConnection): void {
    this.network.addConnection(transport);
  }
}
