// PacketSerializer: encode Atoms to wire bytes and decode wire bytes
// back to Atoms. One serializer per `PacketType`, dispatched off the
// 4th byte for inbound and selected explicitly by the producer for
// outbound.
//
// `JsonSerializer` is the JSON-encoding implementation. Future work:
// a `BinarySerializer` for length-prefixed binary payloads. Both share
// the `PacketSerializer` interface.

import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';
import { deserialize, serialize as jsonStringify } from './BlockSerializer.ts';
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

/** One serializer per `PacketType`. Dispatched off the type byte for inbound. */
export interface PacketSerializer<T> {
  readonly packetType: PacketType;

  /**
   * Encode a payload to wire bytes and produce the resulting Atom.
   * For signed `PacketType`s, `privateKey` must be provided.
   * Returns null if validation of the payload (or signing) fails.
   */
  serialize(payload: T, source: AtomSource, privateKey?: Uint8Array): Atom | null;

  /**
   * Parse wire bytes into an Atom. Returns null on any malformed input
   * (with a structured log per AGENTS.md's "never drop errors silently").
   */
  deserialize(raw: Uint8Array, source: AtomSource): Atom | null;
}

// -- AtomBuilder callback --------------------------------------------

/**
 * Type-specific build step shared by both directions:
 * - On `deserialize`, `payload` is freshly parsed and untyped (`unknown`);
 *   the builder validates the shape.
 * - On `serialize`, `payload` is the caller's typed value (revalidated
 *   to keep both paths consistent).
 *
 * Returns the constructed Atom or `null` if validation fails.
 */
export type AtomBuilder<T> = (
  payload: T | unknown,
  raw: Uint8Array,
  hash: Hash,
  signature: Uint8Array | undefined,
  signer: Uint8Array | undefined,
  source: AtomSource,
) => Atom | null;

// -- JsonSerializer --------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Serializer for JSON-encoded packets. Configured with whether the
 * packet type carries a trailing signature and a `build` callback
 * that constructs the typed Atom from a (parsed or supplied) payload.
 */
export class JsonSerializer<T> implements PacketSerializer<T> {
  constructor(
    readonly packetType: PacketType,
    readonly atomType: AtomType,
    readonly signed: boolean,
    private readonly build: AtomBuilder<T>,
    private readonly logger?: ScopedLogger,
  ) {}

  // -- Outbound ------------------------------------------------------

  serialize(payload: T, source: AtomSource, privateKey?: Uint8Array): Atom | null {
    if (this.signed && !privateKey) {
      this.logger?.warn('serializeMissingPrivateKey', { packetType: this.packetType });
      return null;
    }

    const payloadJson = jsonStringify(payload);
    const payloadBytes = textEncoder.encode(payloadJson);

    const headerPayload = new Uint8Array(HEADER_SIZE + payloadBytes.length);
    headerPayload[0] = PACKET_MAGIC[0];
    headerPayload[1] = PACKET_MAGIC[1];
    headerPayload[2] = PACKET_MAGIC[2];
    headerPayload[3] = this.packetType;
    headerPayload.set(payloadBytes, HEADER_SIZE);

    let raw: Uint8Array;
    let signature: Uint8Array | undefined;
    let signer: Uint8Array | undefined;

    if (this.signed) {
      const msgHash = Hash.digest(headerPayload).toBytes();
      const sig = secp.sign(msgHash, privateKey!);
      const compact = sig.toCompactRawBytes();

      raw = new Uint8Array(headerPayload.length + SIGNATURE_SIZE);
      raw.set(headerPayload);
      raw.set(compact, headerPayload.length);
      raw[raw.length - 1] = sig.recovery;

      signature = raw.subarray(headerPayload.length);
      signer = secp.getPublicKey(privateKey!, true);
    } else {
      raw = headerPayload;
    }

    const hash = Hash.digest(raw);
    const atom = this.build(payload, raw, hash, signature, signer, source);
    if (!atom) {
      this.logger?.warn('serializeBuildFailed', {
        hash: hash.toHex(),
        packetType: this.packetType,
      });
      return null;
    }
    return atom;
  }

  // -- Inbound -------------------------------------------------------

  deserialize(raw: Uint8Array, source: AtomSource): Atom | null {
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
      // Caller routed to the wrong serializer. Surface loudly so dispatcher
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
