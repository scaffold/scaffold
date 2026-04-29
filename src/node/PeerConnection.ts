import { Block, BlockPayload, createBlockFromPacket } from '../core/Block.ts';
import { AtomSource } from '../core/Atom.ts';
import { Hash } from '../util/Hash.ts';
import {
  composeUnsignedPacket,
  PacketType,
  parsePacket,
  recoverPacketSigner,
} from '../core/Packet.ts';

// -- Wire payload shapes ---------------------------------------------

export interface SignalPayload {
  to: string;
  from: string;
  payload: unknown;
}

export interface RequestPayload {
  hashes: string[];
}

export interface DeliveryPayload {
  hash: string;
  delivered: boolean;
}

export interface PeerInfoPayload {
  peerId: string;
  contracts: string[];
}

// -- Transport interface ----------------------------------------------

/**
 * Minimal transport interface -- byte-level send/receive. Every packet
 * traversing this interface is a Scaffold packet (`SCF + type + payload
 * + signature?`); PeerConnection multiplexes by the leading type byte.
 */
export interface TransportConnection {
  readonly peerId: string;
  send(data: Uint8Array): void;
  onMessage(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

// -- Callback types ---------------------------------------------------

/**
 * Callback when a block packet is received from a peer. The block
 * carries `block.raw` directly; callers re-emitting the block to other
 * peers read those bytes off the Block instead of being passed them
 * separately.
 */
export type BlockReceivedHandler = (
  block: Block,
  peerId: string,
) => void;

// -- PeerConnection ---------------------------------------------------

export class PeerConnection {
  readonly peerId: string;

  private readonly transport: TransportConnection;
  private readonly onBlockReceived: BlockReceivedHandler;

  private signalHandler: ((data: SignalPayload) => void) | null = null;
  private requestHandler: ((data: RequestPayload) => void) | null = null;
  private deliveryHandler: ((data: DeliveryPayload) => void) | null = null;
  private peerInfoHandler: ((data: PeerInfoPayload) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  private closed = false;

  constructor(transport: TransportConnection, onBlockReceived: BlockReceivedHandler) {
    this.transport = transport;
    this.peerId = transport.peerId;
    this.onBlockReceived = onBlockReceived;

    this.transport.onMessage((data: Uint8Array) => {
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

  /**
   * Send a pre-composed block packet to this peer. The caller owns
   * signing and packet construction (via composeBlockPacket); we just
   * push the raw bytes onto the wire.
   */
  sendBlock(raw: Uint8Array): void {
    if (this.closed) return;
    this.transport.send(raw);
  }

  /** Send a signal message (for WebRTC signaling). */
  sendSignal(to: string, from: string, payload: unknown): void {
    this.sendControl(PacketType.Signal, { to, from, payload });
  }

  /** Request specific blocks by hash. */
  requestBlocks(hashes: Hash[]): void {
    this.sendControl(PacketType.Request, {
      hashes: hashes.map((h) => h.toHex()),
    });
  }

  /** Report delivery status. */
  sendDelivery(hash: Hash, delivered: boolean): void {
    this.sendControl(PacketType.Delivery, { hash: hash.toHex(), delivered });
  }

  /** Send peer info. */
  sendPeerInfo(peerId: string, contracts: string[]): void {
    this.sendControl(PacketType.PeerInfo, { peerId, contracts });
  }

  // -- Event handler registration -------------------------------------

  onSignal(handler: (data: SignalPayload) => void): void {
    this.signalHandler = handler;
  }

  onRequest(handler: (data: RequestPayload) => void): void {
    this.requestHandler = handler;
  }

  onDelivery(handler: (data: DeliveryPayload) => void): void {
    this.deliveryHandler = handler;
  }

  onPeerInfo(handler: (data: PeerInfoPayload) => void): void {
    this.peerInfoHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  // -- Close ----------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // -- Internal -------------------------------------------------------

  private sendControl<T>(type: PacketType, payload: T): void {
    if (this.closed) return;
    const packet = composeUnsignedPacket(type, payload);
    this.transport.send(packet.raw);
  }

  private handleMessage(data: Uint8Array): void {
    if (this.closed) return;

    const packet = parsePacket<unknown>(data);
    if (!packet) {
      // Silently drop unparseable bytes -- not a Scaffold packet.
      return;
    }

    switch (packet.type) {
      case PacketType.JsonSignedBlock: {
        // Recover signer from the packet signature so the receiver can
        // never be tricked into trusting a payload-encoded signer.
        const block = createBlockFromPacket(
          packet.payload as BlockPayload,
          packet.raw,
          packet.hash,
          PacketType.JsonSignedBlock,
          AtomSource.Remote,
          packet.signature,
          recoverPacketSigner(packet),
        );
        this.onBlockReceived(block, this.peerId);
        break;
      }
      case PacketType.JsonUnsignedBlock: {
        const block = createBlockFromPacket(
          packet.payload as BlockPayload,
          packet.raw,
          packet.hash,
          PacketType.JsonUnsignedBlock,
          AtomSource.Remote,
        );
        this.onBlockReceived(block, this.peerId);
        break;
      }
      case PacketType.Signal:
        this.signalHandler?.(packet.payload as SignalPayload);
        break;
      case PacketType.Request:
        this.requestHandler?.(packet.payload as RequestPayload);
        break;
      case PacketType.Delivery:
        this.deliveryHandler?.(packet.payload as DeliveryPayload);
        break;
      case PacketType.PeerInfo:
        this.peerInfoHandler?.(packet.payload as PeerInfoPayload);
        break;
    }
  }
}
