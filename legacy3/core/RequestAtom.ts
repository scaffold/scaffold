// RequestAtom: peer-to-peer ask for atoms by hash.
//
// On receipt, the responder looks up each requested hash in its store
// and re-emits the matching atom's raw bytes. Currently used for
// blocks; once IndexAtom lands, peers will use this to fetch the
// body for any indexed hash.

import { Hash } from '../util/Hash.ts';
import { AtomBase, AtomType } from './Atom.ts';
import { JsonSerializer } from './PacketSerializer.ts';
import { PacketType } from './Packet.ts';

// -- Wire payload ----------------------------------------------------

export interface RequestPayload {
  hashes: string[];
}

// -- Atom shape ------------------------------------------------------

export interface RequestAtom extends AtomBase {
  readonly type: AtomType.Request;
  readonly packetType: PacketType.JsonRequest;
  /** Parsed once at deserialize so consumers don't redo hex decoding. */
  readonly hashes: Hash[];
}

// -- Type guard ------------------------------------------------------

function isRequestPayload(p: unknown): p is RequestPayload {
  if (typeof p !== 'object' || p === null) return false;
  const obj = p as Record<string, unknown>;
  if (!Array.isArray(obj.hashes)) return false;
  return obj.hashes.every((h) => typeof h === 'string');
}

// -- Serializer instance ---------------------------------------------

export const jsonRequestSerializer = new JsonSerializer<RequestPayload>(
  PacketType.JsonRequest,
  AtomType.Request,
  false,
  (payload, raw, hash, signature, signer, source): RequestAtom | null => {
    if (!isRequestPayload(payload)) return null;
    let hashes: Hash[];
    try {
      hashes = payload.hashes.map((h) => Hash.fromHex(h));
    } catch {
      return null;
    }
    return {
      hash,
      type: AtomType.Request,
      packetType: PacketType.JsonRequest,
      raw,
      signature,
      signer,
      source,
      receivedAt: Date.now(),
      fromConnections: [],
      toConnections: new Set(),
      hashes,
    };
  },
);
