import { Hash } from '../util/Hash.ts';
import { BitVector, CHUNK_BYTES } from './BitVector.ts';

// -- Helpers --------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// -- Replacer / Reviver ---------------------------------------------

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Hash) {
    return { __t: 'H', v: value.toHex() };
  }
  if (value instanceof Uint8Array) {
    return { __t: 'B', v: uint8ToBase64(value) };
  }
  if (typeof value === 'bigint') {
    return { __t: 'N', v: value.toString() };
  }
  if (value instanceof BitVector) {
    const chunks: (string | null)[] = [];
    for (let i = 0; i < value.chunkCount; i++) {
      if (value.isChunkLoaded(i)) {
        // Extract chunk bytes by reading individual bits
        const chunkBytes = new Uint8Array(CHUNK_BYTES);
        for (let bit = 0; bit < CHUNK_BYTES * 8; bit++) {
          const globalBit = i * CHUNK_BYTES * 8 + bit;
          if (globalBit < value.length && value.get(globalBit)) {
            const byteIdx = Math.floor(bit / 8);
            const bitOffset = bit % 8;
            chunkBytes[byteIdx] |= (1 << bitOffset);
          }
        }
        chunks.push(uint8ToBase64(chunkBytes));
      } else {
        chunks.push(null);
      }
    }
    return { __t: 'BV', len: value.length, chunks };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__t' in value) {
    const tagged = value as Record<string, unknown>;
    switch (tagged.__t) {
      case 'H':
        return Hash.fromHex(tagged.v as string);
      case 'B':
        return base64ToUint8(tagged.v as string);
      case 'N':
        return BigInt(tagged.v as string);
      case 'BV': {
        const len = tagged.len as number;
        const chunks = tagged.chunks as (string | null)[];
        const bv = BitVector.unknown(len);
        for (let i = 0; i < chunks.length; i++) {
          if (chunks[i] !== null) {
            bv.loadChunk(i, base64ToUint8(chunks[i]!));
          }
        }
        return bv;
      }
    }
  }
  return value;
}

// -- Public API -----------------------------------------------------

/** Serialize a value to JSON with type-tagged encoding for Hash, Uint8Array, bigint, BitVector. */
export function serialize(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/** Deserialize a JSON string produced by `serialize`. */
export function deserialize<T>(json: string): T {
  return JSON.parse(json, reviver) as T;
}
