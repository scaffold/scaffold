import { Block, BlockStore } from '../core/Block.ts';
import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { NetworkManager, NetworkPlugin } from './NetworkManager.ts';
import { BlockSerializer, createDefaultBlockSerializer, PeerConnection } from './PeerConnection.ts';
import { GossipService } from './GossipService.ts';
import { BlockAwareness, PushAction } from './GossipModule.ts';
import { DeliveryTracker } from './DeliveryTracker.ts';
import { SyncProtocol } from './SyncProtocol.ts';
import { ConsensusService } from '../core/ConsensusService.ts';

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
  consensus: ConsensusService;
  gossip: GossipService;
  processBlock: (block: Block, peerId: string) => void;
  serializer?: BlockSerializer;
}

/**
 * Bridges the network layer and the protocol stack.
 *
 * Inbound:  NetworkManager receives block -> processBlock(block, peerId)
 * Outbound: Gossip push actions -> NetworkManager.sendBlock(block, [peer])
 * Lifecycle: Peer connect/disconnect -> gossip.addPeer/removePeer
 * Sync:     New peer -> exchange tips and request missing blocks
 * Requests: Peer requests blocks -> look up in store and send back
 */
export class NetworkBridge {
  private readonly network: NetworkManager;
  private readonly gossip: GossipService;
  private readonly store: BlockStore;
  private readonly delivery: DeliveryTracker;
  private readonly sync: SyncProtocol;
  private readonly consensus: ConsensusService;

  constructor(deps: NetworkBridgeDeps) {
    this.gossip = deps.gossip;
    this.store = deps.store;
    this.delivery = new DeliveryTracker();
    this.consensus = deps.consensus;

    this.sync = new SyncProtocol(
      deps.store,
      () => this.getCanonicalTips(),
      () => this.getCanonicalDepth(),
    );

    this.network = new NetworkManager(
      deps.plugins,
      {
        onBlockReceived: (block, peerId) => {
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
      this.gossip.reportPush(block.hash, action.peer);
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
    // Register peer with gossip (using peerId as pubkey placeholder)
    this.gossip.addPeer(peer.peerId, peer.peerId, new SetAwareness());

    // Register message handlers on the peer
    peer.onSync((data) => {
      this.sync.handleSync(peer, data.tips, data.depth);
    });

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
        this.gossip.reportDelivery(hash, peer.peerId, true);
      }
    });

    // Initiate sync
    this.sync.initSync(peer);
  }

  private handlePeerDisconnected(peerId: string): void {
    this.gossip.removePeer(peerId);
  }

  private getCanonicalTips(): Hash[] {
    // Return canonical leaf blocks (blocks with no canonical children)
    const canonical = this.consensus.getCanonicalView();
    const hasChild = new Set<string>();
    for (const key of canonical) {
      const block = this.store.get(Hash.fromPrimitive(key));
      if (block) {
        hasChild.add(block.anchor.toPrimitive());
      }
    }
    const tips: Hash[] = [];
    for (const key of canonical) {
      if (!hasChild.has(key)) {
        tips.push(Hash.fromPrimitive(key));
      }
    }
    return tips;
  }

  private getCanonicalDepth(): number {
    const tips = this.getCanonicalTips();
    let maxDepth = 0;
    for (const tip of tips) {
      let depth = 0;
      let cur = tip;
      while (this.store.has(cur)) {
        depth++;
        const block = this.store.get(cur)!;
        if (Hash.equals(block.anchor, ZERO_HASH)) break;
        cur = block.anchor;
      }
      if (depth > maxDepth) maxDepth = depth;
    }
    return maxDepth;
  }
}
