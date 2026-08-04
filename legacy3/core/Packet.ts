import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';

// -- PacketType enum ------------------------------------------------

/**
 * Wire format selector: the 4th byte of every packet is a `PacketType`
 * value that selects the serializer used to parse the rest of the
 * bytes.
 *
 * `PacketType` is a *wire-encoding* tag, not a logical kind. Two
 * different `PacketType`s can produce the same `AtomType` (e.g. a
 * future `BinarySignedBlock` would join `JsonSignedBlock` in producing
 * `AtomType.Block`). See `src/core/Atom.ts` for `AtomType`.
 *
 * Layout: `[SCF magic][type byte][payload][signature?]`. Whether a
 * trailing signature is present is determined by the `PacketType` (via
 * `isSigned`), not by a flag.
 */
export enum PacketType {
  JsonSignedBlock = 0,
  JsonUnsignedBlock = 1,
  JsonSignal = 2,
  JsonRequest = 4,
}

// -- Constants ------------------------------------------------------

export const PACKET_MAGIC = new Uint8Array([83, 67, 70]); // "SCF"
export const HEADER_SIZE = 4; // 3 magic + 1 type
export const SIGNATURE_SIZE = 65; // 64-byte compact + 1-byte recovery

/** Returns whether a packet type includes a trailing signature. */
export function isSigned(type: PacketType): boolean {
  return type === PacketType.JsonSignedBlock;
}

/** Returns whether the byte is a known PacketType value. */
export function isKnownPacketType(b: number): b is PacketType {
  return b === PacketType.JsonSignedBlock ||
    b === PacketType.JsonUnsignedBlock ||
    b === PacketType.JsonSignal ||
    b === PacketType.JsonRequest;
}

// -- Header sniff ---------------------------------------------------

/**
 * Validate magic bytes + type byte and report the recognised
 * `PacketType`. Used by dispatchers (PeerConnection, StorageManager) to
 * route raw bytes to the appropriate serializer without a full payload
 * parse. Returns null on bad magic, unknown type, or short input.
 */
export function parseHeader(raw: Uint8Array): { type: PacketType } | null {
  if (raw.length < HEADER_SIZE) return null;
  if (raw[0] !== PACKET_MAGIC[0] || raw[1] !== PACKET_MAGIC[1] || raw[2] !== PACKET_MAGIC[2]) {
    return null;
  }
  const typeByte = raw[3];
  if (!isKnownPacketType(typeByte)) return null;
  return { type: typeByte };
}

// -- Signature verification -----------------------------------------

/**
 * Structural shape needed to recover/verify a signature: just the wire
 * bytes and the trailing signature. Block (and any future signed Atom)
 * satisfies this.
 */
export interface SignedBytes {
  readonly raw: Uint8Array;
  readonly signature?: Uint8Array;
}

/** Recover the compressed public key (33 bytes) from signed bytes. */
export function recoverPacketSigner(packet: SignedBytes): Uint8Array | undefined {
  if (!packet.signature) return undefined;

  const headerPayload = packet.raw.subarray(0, packet.raw.length - SIGNATURE_SIZE);
  const msgHash = Hash.digest(headerPayload).toBytes();
  const compact = packet.signature.subarray(0, 64);
  const recovery = packet.signature[64] as 0 | 1;

  try {
    const sig = secp.Signature.fromCompact(compact).addRecoveryBit(recovery);
    return sig.recoverPublicKey(msgHash).toRawBytes(true);
  } catch {
    return undefined;
  }
}

/** Verify a signed packet's signature against an expected public key. */
export function verifyPacketSignature(
  packet: SignedBytes,
  expectedPublicKey: Uint8Array,
): boolean {
  if (!packet.signature) return false;

  const headerPayload = packet.raw.subarray(0, packet.raw.length - SIGNATURE_SIZE);
  const msgHash = Hash.digest(headerPayload).toBytes();
  const compact = packet.signature.subarray(0, 64);

  try {
    return secp.verify(compact, msgHash, expectedPublicKey);
  } catch {
    return false;
  }
}
