import { Block } from '../core/Block.ts';
import { BlockSerializer, PeerConnection, TransportConnection } from './PeerConnection.ts';

/** Network plugin interface - what the user provides. */
export interface NetworkPlugin {
  /** Start the plugin, providing a driver for callbacks. */
  start(driver: NetworkDriver): void;
  /** Stop the plugin. */
  stop(): void;
  /** Connect to a specific address. */
  connect(address: string): void;
}

/** Driver provided to network plugins so they can report new connections. */
export interface NetworkDriver {
  /** Called when a new peer connects via this plugin's transport. */
  onConnection(transport: TransportConnection): void;
}

/** Callback for when a block arrives from the network. */
type BlockReceivedHandler = (block: Block, peerId: string) => void;

/** Callbacks for peer lifecycle events. */
export interface NetworkManagerCallbacks {
  onBlockReceived: BlockReceivedHandler;
  onPeerConnected?: (peer: PeerConnection) => void;
  onPeerDisconnected?: (peerId: string) => void;
}

/**
 * Manages the lifecycle of network plugins and peer connections, and
 * routes blocks between the local library and the wider network.
 */
export class NetworkManager {
  private _peers = new Map<string, PeerConnection>();
  private driver: NetworkDriver;
  private callbacks: NetworkManagerCallbacks;

  /** Read-only view of currently connected peers. */
  get peers(): ReadonlyMap<string, PeerConnection> {
    return this._peers;
  }

  constructor(
    private plugins: NetworkPlugin[],
    callbacks: NetworkManagerCallbacks,
    private serializer: BlockSerializer,
  ) {
    this.callbacks = callbacks;
    this.driver = {
      onConnection: (transport: TransportConnection) => {
        this.handleNewConnection(transport);
      },
    };
  }

  /** Start all registered plugins. */
  start(): void {
    for (const plugin of this.plugins) {
      plugin.start(this.driver);
    }
  }

  /** Ask every plugin to connect to each of the given bootstrap addresses. */
  bootstrap(addresses: string[]): void {
    for (const address of addresses) {
      for (const plugin of this.plugins) {
        plugin.connect(address);
      }
    }
  }

  /**
   * Send a block to peers.
   *
   * If `targets` is provided and non-empty, send only to those peer IDs.
   * Otherwise broadcast to every connected peer.
   */
  sendBlock(block: Block, targets?: string[]): void {
    if (targets && targets.length > 0) {
      for (const id of targets) {
        const peer = this._peers.get(id);
        if (peer) {
          peer.sendBlock(block);
        }
      }
    } else {
      for (const peer of this._peers.values()) {
        peer.sendBlock(block);
      }
    }
  }

  /** Close every peer connection and stop every plugin. */
  close(): void {
    for (const peer of this._peers.values()) {
      peer.close();
    }
    this._peers.clear();

    for (const plugin of this.plugins) {
      plugin.stop();
    }
  }

  // -- Internal -------------------------------------------------------

  private handleNewConnection(transport: TransportConnection): void {
    const peer = new PeerConnection(
      transport,
      this.callbacks.onBlockReceived,
      this.serializer,
    );

    this._peers.set(peer.peerId, peer);
    this.callbacks.onPeerConnected?.(peer);

    peer.onClose(() => {
      this._peers.delete(peer.peerId);
      this.callbacks.onPeerDisconnected?.(peer.peerId);
    });
  }
}
