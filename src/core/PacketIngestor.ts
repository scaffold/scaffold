// PacketIngestor: dispatch from a wire packet's `PacketType` byte to
// the parser/builder that produces an Atom.
//
// Every PacketType has a single registered ingestor. The dispatcher
// (PeerConnection / StorageManager) sniffs the type byte and calls
// `ingestor.ingest(raw, source)`. The ingestor is responsible for
// validating the wire format, extracting the payload, recovering the
// signer (if signed), and constructing a typed Atom subtype.
//
// `JsonIngestor` is the concrete implementation for JSON-encoded
// packets. Future work: a `BinaryIngestor` for length-prefixed binary
// payloads. The two would share `PacketIngestor` as their interface.

import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';
import { deserialize } from './BlockSerializer.ts';
import { Atom, AtomSource, AtomType } from './Atom.ts';
import {
  HEADER_SIZE,
  isKnownPacketType,
  PACKET_MAGIC,
  PacketType,
  SIGNATURE_SIZE,
} from './Packet.ts';
import { ScopedLogger } from './EventLog.ts';

// -- Interface ------------------------------------------------------

/** One ingestor per `PacketType`. Selected by the dispatcher off the type byte. */
export interface PacketIngestor {
  readonly packetType: PacketType;
  ingest(raw: Uint8Array, source: AtomSource): Atom | null;
}

// -- AtomBuilder callback --------------------------------------------

/**
 * Type-specific build step. Receives the parsed payload (still typed
 * as `unknown` -- the build callback validates shape) plus the wire
 * metadata, and returns the constructed Atom or `null` if validation
 * fails. The ingestor logs `payloadInvalid` on null and returns null.
 */
export type AtomBuilder = (
  payload: unknown,
  raw: Uint8Array,
  hash: Hash,
  signature: Uint8Array | undefined,
  signer: Uint8Array | undefined,
  source: AtomSource,
) => Atom | null;

// -- JsonIngestor ----------------------------------------------------

const textDecoder = new TextDecoder();

/**
 * Ingestor for JSON-encoded packets. Configured with whether the
 * packet type carries a trailing signature and a `build` callback
 * that constructs the typed Atom from the parsed payload.
 *
 * AGENTS.md: every malformed-input path emits a log; nothing is
 * silently dropped.
 */
export class JsonIngestor implements PacketIngestor {
  constructor(
    readonly packetType: PacketType,
    readonly atomType: AtomType,
    readonly signed: boolean,
    private readonly build: AtomBuilder,
    private readonly logger?: ScopedLogger,
  ) {}

  ingest(raw: Uint8Array, source: AtomSource): Atom | null {
    if (raw.length < HEADER_SIZE) {
      this.logger?.warn('packetTooShort', { length: raw.length });
      return null;
    }
    if (raw[0] !== PACKET_MAGIC[0] || raw[1] !== PACKET_MAGIC[1] || raw[2] !== PACKET_MAGIC[2]) {
      this.logger?.debug('packetMagicMismatch', { byte0: raw[0], byte1: raw[1], byte2: raw[2] });
      return null;
    }

    const typeByte = raw[3];
    if (!isKnownPacketType(typeByte)) {
      this.logger?.warn('packetTypeUnknown', { typeByte });
      return null;
    }
    if (typeByte !== this.packetType) {
      // Caller routed to the wrong ingestor. Surface loudly so dispatcher
      // bugs are visible.
      this.logger?.warn('packetTypeMismatch', { expected: this.packetType, got: typeByte });
      return null;
    }

    if (this.signed && raw.length < HEADER_SIZE + SIGNATURE_SIZE) {
      this.logger?.warn('signedPacketTruncated', { length: raw.length });
      return null;
    }

    const payloadEnd = this.signed ? raw.length - SIGNATURE_SIZE : raw.length;
    const payloadJson = textDecoder.decode(raw.subarray(HEADER_SIZE, payloadEnd));

    let payload: unknown;
    try {
      payload = deserialize<unknown>(payloadJson);
    } catch (err) {
      this.logger?.warn('payloadDeserializeFailed', { error: (err as Error).message });
      return null;
    }

    let signature: Uint8Array | undefined;
    let signer: Uint8Array | undefined;
    if (this.signed) {
      signature = raw.subarray(payloadEnd);
      signer = recoverSigner(raw.subarray(0, payloadEnd), signature);
      if (!signer) {
        this.logger?.warn('signerRecoveryFailed', { length: raw.length });
        return null;
      }
    }

    const hash = Hash.digest(raw);
    const atom = this.build(payload, raw, hash, signature, signer, source);
    if (!atom) {
      this.logger?.warn('payloadValidationFailed', {
        hash: hash.toHex(),
        packetType: this.packetType,
      });
      return null;
    }
    return atom;
  }
}

// -- Helpers ---------------------------------------------------------

/**
 * Recover the 33-byte compressed secp256k1 public key from the raw
 * 65-byte signature (compact 64 + recovery 1) over `headerPayload`.
 * Returns undefined on any failure -- caller is expected to log.
 */
export function recoverSigner(
  headerPayload: Uint8Array,
  signature: Uint8Array,
): Uint8Array | undefined {
  if (signature.length !== SIGNATURE_SIZE) return undefined;
  const recovery = signature[SIGNATURE_SIZE - 1];
  if (recovery !== 0 && recovery !== 1) return undefined;
  try {
    const compact = signature.subarray(0, SIGNATURE_SIZE - 1);
    const sig = secp.Signature.fromCompact(compact).addRecoveryBit(recovery);
    const msgHash = Hash.digest(headerPayload).toBytes();
    return sig.recoverPublicKey(msgHash).toRawBytes(true);
  } catch {
    return undefined;
  }
}
