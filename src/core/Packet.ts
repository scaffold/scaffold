import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';
import { deserialize, serialize } from './BlockSerializer.ts';

// -- PacketType enum ------------------------------------------------

/**
 * Wire format selector: the 4th byte of every packet is a `PacketType`
 * value that selects the ingestor used to parse the rest of the bytes.
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
  Signal = 2,
  Request = 4,
  Delivery = 5,
  PeerInfo = 6,
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
    b === PacketType.Signal ||
    b === PacketType.Request ||
    b === PacketType.Delivery ||
    b === PacketType.PeerInfo;
}

// -- Packet interface -----------------------------------------------

export interface Packet<T> {
  readonly hash: Hash;
  readonly type: PacketType;
  readonly payload: T;
  readonly signature: Uint8Array | undefined;
  readonly raw: Uint8Array;
}

// -- Core compose/parse ---------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Compose a signed packet. Signs the hash of (header+payload), appends signature, then hashes the entire buffer. */
export function composePacket<T>(type: PacketType, payload: T, privateKey: Uint8Array): Packet<T> {
  const payloadJson = serialize(payload);
  const payloadBytes = textEncoder.encode(payloadJson);

  const headerPayload = new Uint8Array(HEADER_SIZE + payloadBytes.length);
  headerPayload[0] = PACKET_MAGIC[0];
  headerPayload[1] = PACKET_MAGIC[1];
  headerPayload[2] = PACKET_MAGIC[2];
  headerPayload[3] = type;
  headerPayload.set(payloadBytes, HEADER_SIZE);

  // Sign hash of header+payload
  const msgHash = Hash.digest(headerPayload).toBytes();
  const sig = secp.sign(msgHash, privateKey);
  const compact = sig.toCompactRawBytes();

  // Build full buffer: header + payload + compact(64) + recovery(1)
  const raw = new Uint8Array(headerPayload.length + SIGNATURE_SIZE);
  raw.set(headerPayload);
  raw.set(compact, headerPayload.length);
  raw[raw.length - 1] = sig.recovery;

  const signature = raw.subarray(headerPayload.length);
  const hash = Hash.digest(raw);

  return { hash, type, payload, signature, raw };
}

/** Compose an unsigned packet (no signature section). */
export function composeUnsignedPacket<T>(type: PacketType, payload: T): Packet<T> {
  const payloadJson = serialize(payload);
  const payloadBytes = textEncoder.encode(payloadJson);

  const raw = new Uint8Array(HEADER_SIZE + payloadBytes.length);
  raw[0] = PACKET_MAGIC[0];
  raw[1] = PACKET_MAGIC[1];
  raw[2] = PACKET_MAGIC[2];
  raw[3] = type;
  raw.set(payloadBytes, HEADER_SIZE);

  const hash = Hash.digest(raw);

  return { hash, type, payload, signature: undefined, raw };
}

/** Parse a raw byte buffer into a Packet, or return null on failure. */
export function parsePacket<T>(raw: Uint8Array): Packet<T> | null {
  if (raw.length < HEADER_SIZE) return null;

  // Validate magic
  if (raw[0] !== PACKET_MAGIC[0] || raw[1] !== PACKET_MAGIC[1] || raw[2] !== PACKET_MAGIC[2]) {
    return null;
  }

  // Read type
  const typeByte = raw[3];
  if (!isKnownPacketType(typeByte)) {
    return null;
  }
  const type = typeByte;

  const signed = isSigned(type);

  if (signed && raw.length < HEADER_SIZE + SIGNATURE_SIZE) {
    return null;
  }

  const payloadEnd = signed ? raw.length - SIGNATURE_SIZE : raw.length;
  const payloadBytes = raw.subarray(HEADER_SIZE, payloadEnd);
  const payloadJson = textDecoder.decode(payloadBytes);

  let payload: T;
  try {
    payload = deserialize<T>(payloadJson);
  } catch {
    return null;
  }

  const signature = signed ? raw.subarray(payloadEnd) : undefined;
  const hash = Hash.digest(raw);

  return { hash, type, payload, signature, raw };
}

// -- Signature verification -----------------------------------------

/**
 * Structural shape needed to recover/verify a signature: just the wire
 * bytes and the trailing signature. Both `Packet<T>` and `Block` (and
 * any future signed Atom) satisfy this.
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

// Block-specific compose helpers (`composeBlockPacket`,
// `composeUnsignedBlockPacket`, `composeGenesisPacket`) live in
// `Block.ts` -- they construct Block atoms and would create a circular
// import if they lived here.
