// Protocol spec: docs/protocol/transport.md
//
// Bridges the transport layer and the protocol stack. Owns a TransportManager,
// wires peer lifecycle into the routing/gossip modules, and relays encrypted
// signaling envelopes across the mesh.

import { Block, BlockStore } from '../core/Block.ts';
import { Hash } from '../util/Hash.ts';
import { TransportManager } from './TransportManager.ts';
import { PeerConnection } from './PeerConnection.ts';
import { RoutingService } from './RoutingService.ts';
import { BlockAwareness, PushAction } from './RoutingModule.ts';
import { SignalEnvelope } from './SignalingService.ts';
import { SignalAtom } from '../core/SignalAtom.ts';
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
  private readonly selfId?: string;
  private readonly _log?: ScopedLogger;
  private readonly peerConnectedListeners: ((peerId: string) => void)[] = [];
  private readonly peerDisconnectedListeners: ((peerId: string) => void)[] = [];

  constructor(deps: NetworkBridgeDeps) {
    this.routing = deps.routing;
    this.store = deps.store;
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
    this.transport.sendBlock(block.raw, [peerId]);
    block.toConnections.add(peerId);
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
    const raw = block.raw;
    for (const action of actions) {
      if (block.toConnections.has(action.peer)) continue;
      // Don't echo a block back to a peer who sent it to us.
      if (block.fromConnections.includes(action.peer)) continue;
      this.transport.sendBlock(raw, [action.peer]);
      block.toConnections.add(action.peer);
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

    peer.onRequest((atom) => {
      for (const hash of atom.hashes) {
        const block = this.store.get(hash);
        if (block) {
          peer.sendBlock(block.raw);
        }
      }
    });

    peer.onSignal((atom) => {
      this.handleSignalMessage(atom, peer.peerId);
    });
  }

  private handlePeerDisconnected(peerId: string): void {
    this._log?.info('peerDisconnected', { peerId });
    this.routing.removePeer(peerId);
    for (const cb of this.peerDisconnectedListeners) cb(peerId);
  }

  private handleSignalMessage(atom: SignalAtom, senderPeerId: string): void {
    // Reverse-path forwarding: the addressed atom's first sender is the
    // next hop toward the publisher. If we have the atom and it's
    // local-origin (empty fromConnections), we are the publisher and
    // deliver to the local SignalingService.
    if (atom.replyTo) {
      const target = this.store.get(atom.replyTo);
      if (!target) {
        this._log?.warn('replyToHashUnknown', {
          replyTo: atom.replyTo.toHex(),
          fromPeer: senderPeerId,
        });
        return;
      }
      if (target.fromConnections.length === 0) {
        // We published the addressed atom -- deliver locally if the
        // signal is for us.
        if (this.selfId && atom.to === this.selfId) {
          void this.transport.recvSignalEnvelope(atom.payload as SignalEnvelope);
        } else {
          this._log?.warn('replyToOriginButNotForUs', {
            replyTo: atom.replyTo.toHex(),
            to: atom.to,
          });
        }
        return;
      }
      const nextPeerId = target.fromConnections[0];
      const nextPeer = this.transport.peers.get(nextPeerId);
      if (!nextPeer) {
        this._log?.warn('replyToPathBroken', {
          replyTo: atom.replyTo.toHex(),
          nextPeerId,
        });
        return;
      }
      nextPeer.sendSignal(atom.to, atom.from, atom.payload, atom.replyTo);
      return;
    }

    // Legacy pubkey-only addressing: deliver to self or flood.
    if (this.selfId && atom.to === this.selfId) {
      void this.transport.recvSignalEnvelope(atom.payload as SignalEnvelope);
    } else {
      for (const [peerId, peer] of this.transport.peers) {
        if (peerId !== senderPeerId) {
          peer.sendSignal(atom.to, atom.from, atom.payload);
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
