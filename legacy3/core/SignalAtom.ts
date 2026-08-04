// SignalAtom: encrypted handshake envelope relayed through the mesh.
//
// SignalingService produces opaque encrypted envelopes; this atom is
// the wire wrapping that lets peers route the envelope to its
// addressee (`to`) and identify the sender (`from`) without
// terminating the encrypted session.
//
// Signals are unsigned at the packet layer -- authentication lives
// inside the encrypted payload (ECDH-derived AES key + bound sender
// pubkey).
//
// Optional `replyTo` is a block hash. When present, NetworkBridge
// forwards the signal one hop back along the path the addressed atom
// took into this node (`atom.fromConnections[0]`) instead of flooding.
// Whoever published the addressed atom has it locally with empty
// `fromConnections` and terminates the signal there. Pubkey
// authentication via the `to` field is independent of routing.

import { Hash } from '../util/Hash.ts';
import { AtomBase, AtomType } from './Atom.ts';
import { JsonSerializer } from './PacketSerializer.ts';
import { PacketType } from './Packet.ts';

// -- Wire payload ----------------------------------------------------

export interface SignalPayload {
  to: string;
  from: string;
  payload: unknown;
  /** Hex-encoded hash of an atom whose source is the routing target. */
  replyTo?: string;
}

// -- Atom shape ------------------------------------------------------

export interface SignalAtom extends AtomBase {
  readonly type: AtomType.Signal;
  readonly packetType: PacketType.JsonSignal;
  readonly to: string;
  readonly from: string;
  readonly payload: unknown;
  readonly replyTo?: Hash;
}

// -- Type guard for parsed JSON --------------------------------------

function isSignalPayload(p: unknown): p is SignalPayload {
  if (typeof p !== 'object' || p === null) return false;
  const obj = p as Record<string, unknown>;
  if (typeof obj.to !== 'string' || typeof obj.from !== 'string' || !('payload' in obj)) {
    return false;
  }
  if (obj.replyTo !== undefined && typeof obj.replyTo !== 'string') return false;
  return true;
}

// -- Serializer instance ---------------------------------------------

export const jsonSignalSerializer = new JsonSerializer<SignalPayload>(
  PacketType.JsonSignal,
  AtomType.Signal,
  false,
  (payload, raw, hash, signature, signer, source): SignalAtom | null => {
    if (!isSignalPayload(payload)) return null;
    let replyTo: Hash | undefined;
    if (payload.replyTo !== undefined) {
      try {
        replyTo = Hash.fromHex(payload.replyTo);
      } catch {
        return null;
      }
    }
    return {
      hash,
      type: AtomType.Signal,
      packetType: PacketType.JsonSignal,
      raw,
      signature,
      signer,
      source,
      receivedAt: Date.now(),
      fromConnections: [],
      toConnections: new Set(),
      to: payload.to,
      from: payload.from,
      payload: payload.payload,
      replyTo,
    };
  },
);
