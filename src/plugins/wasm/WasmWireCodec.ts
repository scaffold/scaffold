// Protocol spec: docs/protocol/wasm-abi.md#wire-format

import { Hash, HASH_SIZE } from '../../util/Hash.ts';
import type { Output, Verifier } from '../../core/BlockCreationModule.ts';
import type { Claim } from '../../core/ContractEnv.ts';

// -- Packed (ptr, len) i64 ----------------------------------------

/** Pack a 32-bit pointer and 32-bit length into a single bigint i64. */
export function packPtrLen(ptr: number, len: number): bigint {
  if (ptr < 0 || ptr > 0xFFFFFFFF) throw new Error(`ptr out of range: ${ptr}`);
  if (len < 0 || len > 0xFFFFFFFF) throw new Error(`len out of range: ${len}`);
  return (BigInt(ptr >>> 0) << 32n) | BigInt(len >>> 0);
}

/** Unpack a packed i64 back into (ptr, len). */
export function unpackPtrLen(packed: bigint): { ptr: number; len: number } {
  const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
  const len = Number(packed & 0xFFFFFFFFn);
  return { ptr, len };
}

// -- i128 (round-tripped through TS number for v1) ----------------
//
// The wire uses i128 for coin values; the TS surface uses `number`. Until the
// migration to `bigint` (see plan follow-up), we serialise number -> 16-byte LE
// two's complement and assert read-back values fit Number.MAX_SAFE_INTEGER.

const I128_BYTES = 16;

export function writeI128(view: DataView, offset: number, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`i128 value must be a finite integer: ${value}`);
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`i128 value exceeds safe integer range: ${value}`);
  }
  // Negative values use two's complement extension across all 16 bytes.
  const big = BigInt(value);
  const masked = big < 0n
    ? ((1n << 128n) + big) // two's complement
    : big;
  view.setBigUint64(offset, masked & 0xFFFFFFFFFFFFFFFFn, true);
  view.setBigUint64(offset + 8, (masked >> 64n) & 0xFFFFFFFFFFFFFFFFn, true);
}

export function readI128(view: DataView, offset: number): number {
  const lo = view.getBigUint64(offset, true);
  const hi = view.getBigUint64(offset + 8, true);
  let raw = (hi << 64n) | lo;
  // Sign-extend from 128 bits.
  if (raw >= (1n << 127n)) raw -= 1n << 128n;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`i128 value exceeds safe integer range: ${raw}`);
  }
  return Number(raw);
}

// -- Encoders -----------------------------------------------------

/** Encode a `Verifier`: 32-byte contract hash + u32 params length + params bytes. */
export function encodeVerifier(v: Verifier): Uint8Array {
  const out = new Uint8Array(HASH_SIZE + 4 + v.params.length);
  out.set(v.contract.toBytes(), 0);
  new DataView(out.buffer).setUint32(HASH_SIZE, v.params.length, true);
  out.set(v.params, HASH_SIZE + 4);
  return out;
}

/**
 * Decode a `Verifier` from `bytes` starting at `offset`. Returns the value
 * and the number of bytes consumed.
 */
export function decodeVerifier(
  bytes: Uint8Array,
  offset = 0,
): { value: Verifier; length: number } {
  if (bytes.length < offset + HASH_SIZE + 4) {
    throw new Error('decodeVerifier: short read on header');
  }
  const contract = Hash.fromBytes(bytes.slice(offset, offset + HASH_SIZE));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const paramsLen = view.getUint32(offset + HASH_SIZE, true);
  const paramsStart = offset + HASH_SIZE + 4;
  if (bytes.length < paramsStart + paramsLen) {
    throw new Error('decodeVerifier: short read on params');
  }
  const params = bytes.slice(paramsStart, paramsStart + paramsLen);
  return {
    value: { contract, params },
    length: HASH_SIZE + 4 + paramsLen,
  };
}

/** Encode an `Output`: verifier + i128 value + bytes body. */
export function encodeOutput(o: Output): Uint8Array {
  const verifierBytes = encodeVerifier(o.verifier);
  const body = o.body ?? new Uint8Array(0);
  const out = new Uint8Array(verifierBytes.length + I128_BYTES + 4 + body.length);
  out.set(verifierBytes, 0);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  writeI128(view, verifierBytes.length, o.value);
  view.setUint32(verifierBytes.length + I128_BYTES, body.length, true);
  out.set(body, verifierBytes.length + I128_BYTES + 4);
  return out;
}

export function decodeOutput(
  bytes: Uint8Array,
  offset = 0,
): { value: Output; length: number } {
  const v = decodeVerifier(bytes, offset);
  const valueOffset = offset + v.length;
  if (bytes.length < valueOffset + I128_BYTES + 4) {
    throw new Error('decodeOutput: short read on value/body header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = readI128(view, valueOffset);
  const bodyLen = view.getUint32(valueOffset + I128_BYTES, true);
  const bodyStart = valueOffset + I128_BYTES + 4;
  if (bytes.length < bodyStart + bodyLen) {
    throw new Error('decodeOutput: short read on body');
  }
  const body = bytes.slice(bodyStart, bodyStart + bodyLen);
  return {
    value: { verifier: v.value, value, body },
    length: v.length + I128_BYTES + 4 + bodyLen,
  };
}

/** Decode an `Output` list prefixed with a u32 count (used by `put` records). */
export function decodeOutputList(
  bytes: Uint8Array,
  offset = 0,
): { value: Output[]; length: number } {
  if (bytes.length < offset + 4) {
    throw new Error('decodeOutputList: short read on count');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(offset, true);
  const items: Output[] = [];
  let cursor = offset + 4;
  for (let i = 0; i < count; i++) {
    const { value, length } = decodeOutput(bytes, cursor);
    items.push(value);
    cursor += length;
  }
  return { value: items, length: cursor - offset };
}

/** Encode a `Claim`: verifier + i128 value + bytes body + u8 is_self_claim. */
export function encodeClaim(c: Claim): Uint8Array {
  const verifierBytes = encodeVerifier(c.verifier);
  const out = new Uint8Array(verifierBytes.length + I128_BYTES + 4 + c.body.length + 1);
  out.set(verifierBytes, 0);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  writeI128(view, verifierBytes.length, c.value);
  view.setUint32(verifierBytes.length + I128_BYTES, c.body.length, true);
  out.set(c.body, verifierBytes.length + I128_BYTES + 4);
  out[out.length - 1] = c.isSelfClaim ? 1 : 0;
  return out;
}

/** Encode a list of `Claim`s prefixed with a u32 count (used by `claim_all`). */
export function encodeClaimList(claims: Claim[]): Uint8Array {
  const encodedItems = claims.map(encodeClaim);
  const total = 4 + encodedItems.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(0, claims.length, true);
  let offset = 4;
  for (const item of encodedItems) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

/** Encode a `(value, body)` reply for `request_body` / `contract_metadata`. */
export function encodeValueAndBody(value: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(I128_BYTES + 4 + body.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  writeI128(view, 0, value);
  view.setUint32(I128_BYTES, body.length, true);
  out.set(body, I128_BYTES + 4);
  return out;
}
