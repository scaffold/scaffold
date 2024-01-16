import { base10 } from 'multiformats/bases/base10';
import { base16 } from 'multiformats/bases/base16';
import { base32, base32hex } from 'multiformats/bases/base32';
import { base36 } from 'multiformats/bases/base36';
import { base58btc } from 'multiformats/bases/base58';
import { base64url } from 'multiformats/bases/base64';
import { memoize } from '../util/functional.ts';
import { bin2str, str2bin } from '../util/buffer.ts';

const MULTIBASE_PREFIX = ':';
// const MULTIBASE_ENCODER = base58btc;
const MULTIBASE_ENCODER = base16;

const multibaseMap = Object.fromEntries(
  [base10, base16, base32, base32hex, base36, base58btc, base64url].map(
    (base) => [base.prefix, base],
  ),
);
export const decodeMultibase = (enc: string): Uint8Array => {
  if (enc === '') {
    return new Uint8Array();
  }
  enc = enc.split('.', 1)[0]; // Remove extension
  const decoder = multibaseMap[enc[0]];
  if (!decoder) {
    throw new Error(
      `Unsupported multibase with prefix ${enc[0]}, supported prefixes are {${
        Object.keys(multibaseMap).join(', ')
      }}`,
    );
  }
  return decoder.decode(enc);
};
export const parsePath = (str: string): Uint8Array[] => {
  if (str === '') {
    throw new Error(`Path cannot be empty`);
  }
  if (str === '/') {
    // Special case for root
    return [];
  }

  const entries = str.split('/');
  if (entries.shift() !== '') {
    throw new Error(`Path must be absolute (start with a '/')`);
  }

  return entries.map((entry) => {
    if (entry === '') {
      throw new Error(`Path cannot contain empty entries`);
    }
    if (entry[0] === MULTIBASE_PREFIX) {
      return decodeMultibase(entry.slice(1));
    } else {
      return str2bin(entry);
    }
  });
};
const multibasePrefixCode = MULTIBASE_PREFIX.charCodeAt(0);
export const decodePathEntry = memoize(
  (entry: Uint8Array): Uint8Array =>
    entry[0] === multibasePrefixCode
      ? decodeMultibase(bin2str(entry.subarray(1)))
      : entry,
);

const isCharPrintableRegex = /^[A-Za-z0-9_\-~.]$/;
const isCharPrintableLut = Array.from(
  { length: 256 },
  (_, i) => isCharPrintableRegex.test(String.fromCharCode(i)),
);
export const formatPath = memoize(
  (path: Uint8Array[]): string =>
    '/' +
    path
      .map((entry) =>
        entry.every((i) => isCharPrintableLut[i])
          ? bin2str(entry)
          : MULTIBASE_PREFIX + MULTIBASE_ENCODER.encode(entry)
      )
      .join('/'),
);
