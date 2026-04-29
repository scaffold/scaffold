import { Block, parseBlockPacket } from '../core/Block.ts';
import { AtomSource } from '../core/Atom.ts';
import { Hash } from '../util/Hash.ts';
import { PacketType, parseHeader } from '../core/Packet.ts';
import { jsonSignalSerializer, SignalAtom, SignalPayload } from '../core/SignalAtom.ts';
import { jsonRequestSerializer, RequestAtom } from '../core/RequestAtom.ts';

// Re-export SignalPayload for legacy callers; new code should consume
// SignalAtom directly.
export type { SignalPayload };

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

  private signalHandler: ((atom: SignalAtom) => void) | null = null;
  private requestHandler: ((atom: RequestAtom) => void) | null = null;
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

  /**
   * Send a signal message. If `replyTo` is provided, receiving peers
   * route the signal one hop back along the path the addressed atom
   * took (reverse-path forwarding). Otherwise the receiver floods.
   */
  sendSignal(to: string, from: string, payload: unknown, replyTo?: Hash): void {
    if (this.closed) return;
    const atom = jsonSignalSerializer.serialize(
      { to, from, payload, replyTo: replyTo?.toHex() },
      AtomSource.Local,
    );
    if (!atom) return;
    this.transport.send(atom.raw);
  }

  /** Request specific blocks by hash. */
  requestBlocks(hashes: Hash[]): void {
    if (this.closed) return;
    const atom = jsonRequestSerializer.serialize(
      { hashes: hashes.map((h) => h.toHex()) },
      AtomSource.Local,
    );
    if (!atom) return;
    this.transport.send(atom.raw);
  }

  // -- Event handler registration -------------------------------------

  onSignal(handler: (atom: SignalAtom) => void): void {
    this.signalHandler = handler;
  }

  onRequest(handler: (atom: RequestAtom) => void): void {
    this.requestHandler = handler;
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

  private handleMessage(data: Uint8Array): void {
    if (this.closed) return;

    const header = parseHeader(data);
    if (!header) {
      // Silently drop unparseable bytes -- not a Scaffold packet.
      return;
    }

    switch (header.type) {
      case PacketType.JsonSignedBlock:
      case PacketType.JsonUnsignedBlock: {
        const block = parseBlockPacket(data, AtomSource.Remote, this.peerId);
        if (block) this.onBlockReceived(block, this.peerId);
        break;
      }
      case PacketType.JsonSignal: {
        const atom = jsonSignalSerializer.deserialize(data, AtomSource.Remote) as
          | SignalAtom
          | null;
        if (atom) {
          atom.fromConnections.push(this.peerId);
          this.signalHandler?.(atom);
        }
        break;
      }
      case PacketType.JsonRequest: {
        const atom = jsonRequestSerializer.deserialize(data, AtomSource.Remote) as
          | RequestAtom
          | null;
        if (atom) {
          atom.fromConnections.push(this.peerId);
          this.requestHandler?.(atom);
        }
        break;
      }
    }
  }
}
