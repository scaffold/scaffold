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

import { AtomBase, AtomType } from './Atom.ts';
import { JsonSerializer } from './PacketSerializer.ts';
import { PacketType } from './Packet.ts';

// -- Wire payload ----------------------------------------------------

export interface SignalPayload {
  to: string;
  from: string;
  payload: unknown;
}

// -- Atom shape ------------------------------------------------------

export interface SignalAtom extends AtomBase {
  readonly type: AtomType.Signal;
  readonly packetType: PacketType.JsonSignal;
  readonly to: string;
  readonly from: string;
  readonly payload: unknown;
}

// -- Type guard for parsed JSON --------------------------------------

function isSignalPayload(p: unknown): p is SignalPayload {
  if (typeof p !== 'object' || p === null) return false;
  const obj = p as Record<string, unknown>;
  return typeof obj.to === 'string' && typeof obj.from === 'string' && 'payload' in obj;
}

// -- Serializer instance ---------------------------------------------

export const jsonSignalSerializer = new JsonSerializer<SignalPayload>(
  PacketType.JsonSignal,
  AtomType.Signal,
  false,
  (payload, raw, hash, signature, signer, source): SignalAtom | null => {
    if (!isSignalPayload(payload)) return null;
    return {
      hash,
      type: AtomType.Signal,
      packetType: PacketType.JsonSignal,
      raw,
      signature,
      signer,
      source,
      receivedAt: Date.now(),
      to: payload.to,
      from: payload.from,
      payload: payload.payload,
    };
  },
);
