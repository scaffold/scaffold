import { decodeBase64, encodeBase64 } from '@std/encoding';
import { error } from './functional.ts';
import { Hash } from './Hash.ts';

// -- Tagged JSON ----------------------------------------------------
//
// Lossless JSON for the value types the wire format needs but JSON has no
// literal for. Round-tripping is value-preserving but NOT byte-preserving --
// an atom's `raw` bytes stay the source of truth for its hash.

interface Tagged {
  __t: 'H' | 'B' | 'N';
  v: string;
}

const taggedReplacer = (_key: string, val: unknown): unknown => {
  if (val instanceof Hash) {
    return { __t: 'H', v: val.toHex() } satisfies Tagged;
  } else if (val instanceof Uint8Array) {
    return { __t: 'B', v: encodeBase64(val) } satisfies Tagged;
  } else if (typeof val === 'bigint') {
    return { __t: 'N', v: val.toString() } satisfies Tagged;
  } else {
    return val;
  }
};

const taggedReviver = (_key: string, val: unknown): unknown => {
  if (typeof val !== 'object' || val === null || !('__t' in val)) {
    return val;
  }

  const { __t, v } = val as Tagged;
  if (typeof v !== 'string') {
    error(`Tagged value '${__t}' has a non-string body!`);
  }

  switch (__t) {
    case 'H':
      return Hash.fromHex(v);
    case 'B':
      return decodeBase64(v);
    case 'N':
      return BigInt(v);
    default:
      return error(`Unknown type tag '${__t}'!`);
  }
};

/** Encode a value, tagging Hash / Uint8Array / bigint so they survive the trip. */
export const taggedStringify = (val: unknown) => JSON.stringify(val, taggedReplacer);

/** Decode a `taggedStringify` payload. Throws on malformed input. */
export const taggedParse = (json: string): unknown => JSON.parse(json, taggedReviver);

export const jsonSafeStringify = (obj: unknown, space?: number) => {
  const ancestors: unknown[] = [];
  return JSON.stringify(obj, function (_key, val) {
    switch (typeof val) {
      case 'bigint':
        return val.toString();
      case 'object':
        if (val === null) {
          return null;
        } else if ('hash' in val && val.hash instanceof Hash) {
          return { hash: val.hash.toHex() };
        } else if (val instanceof Hash) {
          return val.toHex();
        } else {
          while (ancestors.length > 0 && ancestors.at(-1) !== this) {
            ancestors.pop();
          }
          if (ancestors.includes(val)) {
            return '[circular]';
          } else {
            ancestors.push(val);
            return val;
          }
        }
      default:
        return val;
    }
  }, space);
};
