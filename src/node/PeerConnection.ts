import { Block } from '../core/Block.ts';
import { Hash } from '../util/Hash.ts';
import {
  deserialize as blockDeserialize,
  serialize as blockSerialize,
} from '../core/BlockSerializer.ts';

// -- Wire message types -----------------------------------------------

export type PeerMessage =
  | { type: 'block'; data: object }
  | { type: 'signal'; data: { to: string; from: string; payload: unknown } }
  | { type: 'sync'; data: { tips: string[]; depth: number } }
  | { type: 'request'; data: { hashes: string[] } }
  | { type: 'delivery'; data: { hash: string; delivered: boolean } }
  | { type: 'peerInfo'; data: { peerId: string; contracts: string[] } };

// -- Transport interface ----------------------------------------------

/** Minimal transport interface - what the network plugin provides. */
export interface TransportConnection {
  readonly peerId: string;
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

// -- Block serializer interface ---------------------------------------

/** Serializer that converts blocks to/from plain objects for embedding in messages. */
export interface BlockSerializer {
  serialize(block: Block): object;
  deserialize(data: object): Block;
}

// -- Callback types ---------------------------------------------------

/** Callback for when a block is received from a peer. */
export type BlockReceivedHandler = (block: Block, peerId: string) => void;

// -- Default serializer adapter ---------------------------------------

/**
 * Create a BlockSerializer adapter from the existing string-based
 * serialize/deserialize in BlockSerializer.ts.
 *
 * serialize: Block -> JSON string -> parsed object
 * deserialize: object -> JSON string -> Block
 */
export function createDefaultBlockSerializer(): BlockSerializer {
  return {
    serialize(block: Block): object {
      return JSON.parse(blockSerialize(block)) as object;
    },
    deserialize(data: object): Block {
      return blockDeserialize<Block>(JSON.stringify(data));
    },
  };
}

// -- PeerConnection ---------------------------------------------------

export class PeerConnection {
  readonly peerId: string;

  private readonly transport: TransportConnection;
  private readonly onBlockReceived: BlockReceivedHandler;
  private readonly serializer: BlockSerializer;

  private signalHandler: ((data: { to: string; from: string; payload: unknown }) => void) | null =
    null;
  private syncHandler: ((data: { tips: string[]; depth: number }) => void) | null = null;
  private requestHandler: ((data: { hashes: string[] }) => void) | null = null;
  private deliveryHandler: ((data: { hash: string; delivered: boolean }) => void) | null = null;
  private peerInfoHandler: ((data: { peerId: string; contracts: string[] }) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  private closed = false;

  constructor(
    transport: TransportConnection,
    onBlockReceived: BlockReceivedHandler,
    serializer: BlockSerializer,
  ) {
    this.transport = transport;
    this.peerId = transport.peerId;
    this.onBlockReceived = onBlockReceived;
    this.serializer = serializer;

    // Wire up transport message handling
    this.transport.onMessage((data: string) => {
      this.handleMessage(data);
    });

    this.transport.onClose(() => {
      this.closed = true;
      if (this.closeHandler) {
        this.closeHandler();
      }
    });
  }

  // -- Send methods ---------------------------------------------------

  /** Send a block to this peer. */
  sendBlock(block: Block): void {
    if (this.closed) return;
    const message: PeerMessage = {
      type: 'block',
      data: this.serializer.serialize(block),
    };
    this.transport.send(JSON.stringify(message));
  }

  /** Send a signal message (for WebRTC signaling). */
  sendSignal(to: string, from: string, payload: unknown): void {
    if (this.closed) return;
    const message: PeerMessage = {
      type: 'signal',
      data: { to, from, payload },
    };
    this.transport.send(JSON.stringify(message));
  }

  /** Send sync message with canonical tips. */
  sendSync(tips: Hash[], depth: number): void {
    if (this.closed) return;
    const message: PeerMessage = {
      type: 'sync',
      data: { tips: tips.map((t) => t.toHex()), depth },
    };
    this.transport.send(JSON.stringify(message));
  }

  /** Request specific blocks by hash. */
  requestBlocks(hashes: Hash[]): void {
    if (this.closed) return;
    const message: PeerMessage = {
      type: 'request',
      data: { hashes: hashes.map((h) => h.toHex()) },
    };
    this.transport.send(JSON.stringify(message));
  }

  /** Report delivery status. */
  sendDelivery(hash: Hash, delivered: boolean): void {
    if (this.closed) return;
    const message: PeerMessage = {
      type: 'delivery',
      data: { hash: hash.toHex(), delivered },
    };
    this.transport.send(JSON.stringify(message));
  }

  /** Send peer info. */
  sendPeerInfo(peerId: string, contracts: string[]): void {
    if (this.closed) return;
    const message: PeerMessage = {
      type: 'peerInfo',
      data: { peerId, contracts },
    };
    this.transport.send(JSON.stringify(message));
  }

  // -- Event handler registration -------------------------------------

  /** Register handler for signal messages. */
  onSignal(handler: (data: { to: string; from: string; payload: unknown }) => void): void {
    this.signalHandler = handler;
  }

  /** Register handler for sync messages. */
  onSync(handler: (data: { tips: string[]; depth: number }) => void): void {
    this.syncHandler = handler;
  }

  /** Register handler for request messages. */
  onRequest(handler: (data: { hashes: string[] }) => void): void {
    this.requestHandler = handler;
  }

  /** Register handler for delivery messages. */
  onDelivery(handler: (data: { hash: string; delivered: boolean }) => void): void {
    this.deliveryHandler = handler;
  }

  /** Register handler for peerInfo messages. */
  onPeerInfo(handler: (data: { peerId: string; contracts: string[] }) => void): void {
    this.peerInfoHandler = handler;
  }

  /** Register handler for connection close. */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  // -- Close ----------------------------------------------------------

  /** Close the connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  /** Whether this connection has been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  // -- Internal message dispatch --------------------------------------

  private handleMessage(data: string): void {
    if (this.closed) return;

    let message: PeerMessage;
    try {
      message = JSON.parse(data) as PeerMessage;
    } catch {
      // Silently ignore malformed JSON
      return;
    }

    switch (message.type) {
      case 'block': {
        const block = this.serializer.deserialize(message.data);
        this.onBlockReceived(block, this.peerId);
        break;
      }
      case 'signal':
        if (this.signalHandler) {
          this.signalHandler(message.data);
        }
        break;
      case 'sync':
        if (this.syncHandler) {
          this.syncHandler(message.data);
        }
        break;
      case 'request':
        if (this.requestHandler) {
          this.requestHandler(message.data);
        }
        break;
      case 'delivery':
        if (this.deliveryHandler) {
          this.deliveryHandler(message.data);
        }
        break;
      case 'peerInfo':
        if (this.peerInfoHandler) {
          this.peerInfoHandler(message.data);
        }
        break;
    }
  }
}
