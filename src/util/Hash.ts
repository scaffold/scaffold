// @noble/hashes rather than WebCrypto or @std/crypto because digesting has to
// be synchronous: `crypto.subtle.digest` is async-only, and @std/crypto's sync
// path is WASM, which cannot be compiled on the main thread above 4KB.
import { sha3_256, shake256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bin2hex, hex2bin } from './hex.ts';
import { arrConcat, arrFromNumber, str2bin } from './buffer.ts';
import { DevtoolsFormattable } from '../../plugins/browser/devtoolsFormatterPlugin.ts';
import { assert } from './functional.ts';

// TODO: Try blake?

const hasher = {
  'sha2': sha256,
  'sha3': sha3_256,
  'shake': (data: Uint8Array) => shake256(data, { dkLen: HASH_SIZE }),
}.sha3;

export const HASH_SIZE = 32;
export const HASH_HEX_SIZE = HASH_SIZE * 2;
export const HASH_BITS = HASH_SIZE * 8;
export const HASH_REGEX = /^[a-fA-F0-9]{64}$/;

export class Hash implements DevtoolsFormattable {
  private hex: string;

  private name?: string;
  private static names = new Map<HashPrimitive, string>();

  private constructor(private digest: Uint8Array) {
    if (digest.byteLength !== HASH_SIZE) {
      throw new Error(`Invalid digest length`);
    }
    this.hex = bin2hex(digest);
    this.name = Hash.names.get(this.toPrimitive());
  }

  [Symbol.for('Deno.customInspect')](
    inspect: (value: unknown, options: unknown) => string,
    options: unknown,
  ): string {
    if (this.name !== undefined) {
      return `Hash(${inspect(this.name, options)} -> ${inspect(this.toHex(), options)})`;
    } else {
      return `Hash(${inspect(this.toHex(), options)})`;
    }
  }

  setName(name: string) {
    Hash.names.set(this.toPrimitive(), name);
    this.name = name;
  }

  static fromBytes(bytes: Uint8Array) {
    return new Hash(bytes);
  }

  static fromHex(hex: string) {
    return new Hash(hex2bin(hex));
  }

  static fromBigint(num: bigint) {
    if ((num >> 256n) !== 0n) {
      throw new Error(`Cannot convert bigint to Hash - out of range!`);
    }
    const arr = new Uint8Array(32);
    const view = new DataView(arr.buffer);
    view.setBigUint64(0, (num >> 192n) & 0xFFFFFFFFFFFFFFFFn);
    view.setBigUint64(8, (num >> 128n) & 0xFFFFFFFFFFFFFFFFn);
    view.setBigUint64(16, (num >> 64n) & 0xFFFFFFFFFFFFFFFFn);
    view.setBigUint64(24, num & 0xFFFFFFFFFFFFFFFFn);
    return new Hash(arr);
  }

  static fromPrimitive(primitive: HashPrimitive) {
    return Hash.fromHex(primitive);
    // return Hash.fromBigint(primitive);
  }

  static fromFraction(num: number, den: number) {
    // TODO: Make this more accurate
    if (num < den) {
      return Hash.fromHex((num / den).toString(16).slice(2, 66).padEnd(64, '0'));
    } else {
      return Hash.fromHex('f'.repeat(64));
    }
  }

  static fromLiteral32(num: number) {
    const b0 = (num >>> 0) & 0xff;
    const b1 = (num >>> 8) & 0xff;
    const b2 = (num >>> 16) & 0xff;
    const b3 = (num >>> 24) & 0xff;
    const signBit = ((num >> 16) >> 16) & 0xff;
    return new Hash(
      new Uint8Array([...new Array(28).fill(signBit), b3, b2, b1, b0]),
    );
  }

  static fromLiteralStr(str: string) {
    if (str.length > HASH_SIZE) {
      throw new Error(`String ${str} is more than ${HASH_SIZE} characters`);
    }
    return new Hash(new TextEncoder().encode(str.padStart(HASH_SIZE, '\0')));
  }

  static digest(data: Uint8Array | string) {
    const hash = new Hash(hasher(typeof data === 'string' ? str2bin(data) : data));
    if (typeof data === 'string' && data.length <= 16) {
      hash.setName(data);
    }
    return hash;
  }

  // TODO: Eliminate this monstrosity
  // It's slightly insecure because we don't lenght-prefix the parts
  static digestParts(...parts: (Hash | Uint8Array | string | number)[]) {
    return Hash.digest(
      arrConcat(
        ...parts.map((p) =>
          p instanceof Hash
            ? p.toBytes()
            : p instanceof Uint8Array || typeof p === 'string'
            ? Hash.digest(p).toBytes()
            : arrFromNumber(p, 4)
        ),
      ),
    );
  }

  static random() {
    const data = new Uint8Array(HASH_SIZE);
    crypto.getRandomValues(data);
    return new Hash(data);
  }

  toBytes() {
    return this.digest;
  }

  toHex() {
    return this.hex;
    // return bin2hex(this.digest);
  }

  toBigint() {
    const view = new DataView(this.digest.buffer, this.digest.byteOffset);
    return (view.getBigUint64(0) << 192n) | (view.getBigUint64(8) << 128n) |
      (view.getBigUint64(16) << 64n) | view.getBigUint64(24);
  }

  // TODO: Use global Map + FinalizationRegistry to make the Hash object a unique primitive
  toPrimitive() {
    return this.toHex();
    // return this.toBigint();
  }

  static composePrimitives(
    a: HashPrimitive & (string | bigint),
    b: HashPrimitive & (string | bigint),
  ) {
    return a + b;
    // return (a << 1n) ^ b;
  }

  countLeadingZeros() {
    let count = 0;
    for (const b of this.digest) {
      for (let i = 8; i-- > 0;) {
        if ((b >> i) & 1) {
          return count;
        }
        count++;
      }
    }
    return count;
  }

  population() {
    let pop = 0;
    for (const b of this.digest) {
      for (let i = 0; i < 8; i++) {
        pop += (b >> i) & 1;
      }
    }
    return pop;
  }

  weightedPopulation(weightStart: number, weightEnd: number) {
    const inc = (weightEnd - weightStart) / 256;
    let pop = 0;
    for (const b of this.digest) {
      for (let i = 0; i < 8; i++) {
        pop += (b >> i) & 1 ? weightStart : 0;
        weightStart += inc;
      }
    }
    return pop;
  }

  increment() {
    const b = new Uint8Array(this.digest);
    for (let i = HASH_SIZE; i-- > 0;) {
      b[i]++;
      if (b[i] !== 0) {
        break;
      }
    }
    return Hash.fromBytes(b);
  }

  bit(index: number) {
    return (this.digest[index >>> 3] >>> (index & 7)) & 1;
  }

  static xor(h0: Hash, h1: Hash) {
    const res = new Uint8Array(HASH_SIZE);
    for (let i = 0; i < HASH_SIZE; i++) {
      res[i] = h0.digest[i] ^ h1.digest[i];
    }
    return Hash.fromBytes(res);
  }

  static add(h0: Hash, h1: Hash) {
    const res = new Uint8Array(HASH_SIZE);
    let c = 0;
    for (let i = HASH_SIZE; i-- > 0;) {
      c += h0.digest[i] + h1.digest[i];
      res[i] = c;
      c >>>= 8;
    }
    return Hash.fromBytes(res);
  }

  static combine(...hashes: Hash[]) {
    // TODO: Maybe there's a faster way to do this? Addition?
    return Hash.digest(arrConcat(...hashes.map((h) => h.toBytes())));
  }

  static equals(h0: Hash, h1: Hash) {
    if (h0 === h1) {
      return true;
    }
    for (let i = 0; i < HASH_SIZE; i++) {
      if (h0.digest[i] !== h1.digest[i]) {
        return false;
      }
    }
    return true;
  }

  static compare(h0: Hash, h1: Hash) {
    for (let i = 0; i < HASH_SIZE; i++) {
      if (h0.digest[i] < h1.digest[i]) {
        return -1;
      } else if (h0.digest[i] > h1.digest[i]) {
        return 1;
      }
    }
    return 0;
  }

  _devtoolsFormatHeader() {
    return null;
    // return ['span', {}, this.toHex().slice(0, 8)] as const;
  }
}

export type HashPrimitive = ReturnType<Hash['toPrimitive']>;

export const ZERO_HASH = Hash.fromBytes(new Uint8Array(HASH_SIZE));
export const EMPTY_HASH = Hash.digest(new Uint8Array());

const test = Hash.random();
assert(Hash.equals(Hash.fromBigint(test.toBigint()), test));
// assert(bin2bigint(test.toBytes()) === test.toBigint());
