// Uncaught RangeError: WebAssembly.Compile is disallowed on the main thread, if the buffer size is larger than 4KB. Use WebAssembly.compile, or compile on a worker thread.
// import { crypto } from 'std-latest/crypto/mod.ts';

import { Sha256 } from 'https://deno.land/std@0.160.0/hash/sha256.ts';
import { Sha3_256, Shake256 } from 'https://deno.land/std@0.160.0/hash/sha3.ts';
import { bin2hex, hex2bin } from './hex.ts';
import { arrConcat, arrFromNumber, bin2str, str2bin } from './buffer.ts';
// import { sha256 } from '@noble/hashes/sha256';

// TODO: Try blake?

const hasher = {
  // 'sha2': (data: Uint8Array) => {
  //   return new Uint8Array(crypto.subtle.digestSync('SHA-256', data));
  // },
  // 'sha3': (data: Uint8Array) => {
  //   return new Uint8Array(crypto.subtle.digestSync('SHA3-256', data));
  // },
  'sha2': (data: Uint8Array) => {
    const algo = new Sha256();
    algo.update(data);
    return new Uint8Array(algo.digest());
  },
  'sha3': (data: Uint8Array) => {
    const algo = new Sha3_256();
    algo.update(data);
    return new Uint8Array(algo.digest());
  },
  'shake': (data: Uint8Array) => {
    const algo = new Shake256(256);
    algo.update(data);
    return new Uint8Array(algo.digest());
  },
}.sha3;

export const HASH_SIZE = 32;

const nonPrintableRegex = /[^\u0020-\u007E]/g;

export default class Hash {
  // TODO: Remove; only for debugging
  private name: string;

  private hex: string;

  private constructor(private digest: Uint8Array) {
    if (digest.byteLength !== HASH_SIZE) {
      throw new Error(`Invalid digest length`);
    }
    this.hex = bin2hex(this.digest);

    this.name = bin2str(this.digest).slice(-16).replace(nonPrintableRegex, '');
  }

  public static fromBytes(bytes: Uint8Array) {
    return new Hash(bytes);
  }

  public static fromHex(hex: string) {
    return new Hash(hex2bin(hex));
  }

  public static fromBigint(num: bigint) {
    const arr = new Uint8Array(32);
    const view = new DataView(arr.buffer);
    view.setBigUint64(0, (num >> 192n) & 0xFFFFFFFFFFFFFFFFn);
    view.setBigUint64(8, (num >> 128n) & 0xFFFFFFFFFFFFFFFFn);
    view.setBigUint64(16, (num >> 64n) & 0xFFFFFFFFFFFFFFFFn);
    view.setBigUint64(24, num & 0xFFFFFFFFFFFFFFFFn);
    return new Hash(arr);
  }

  public static fromPrimitive(primitive: HashPrimitive) {
    return Hash.fromHex(primitive);
    // return Hash.fromBigint(primitive);
  }

  public static fromFraction(num: number, den: number) {
    // TODO: Make this more accurate
    if (num < den) {
      return Hash.fromHex((num / den).toString(16).slice(2).padEnd(64, '0'));
    } else {
      return Hash.fromHex('f'.repeat(64));
    }
  }

  public static fromLiteral32(num: number) {
    const b0 = (num >>> 0) & 0xff;
    const b1 = (num >>> 8) & 0xff;
    const b2 = (num >>> 16) & 0xff;
    const b3 = (num >>> 24) & 0xff;
    const signBit = ((num >> 16) >> 16) & 0xff;
    return new Hash(
      new Uint8Array([...new Array(28).fill(signBit), b3, b2, b1, b0]),
    );
  }

  public static fromLiteralStr(str: string) {
    if (str.length > HASH_SIZE) {
      throw new Error(`String ${str} is more than ${HASH_SIZE} characters`);
    }
    return new Hash(new TextEncoder().encode(str.padStart(HASH_SIZE, '\0')));
  }

  public static digest(data: Uint8Array | string) {
    if (typeof data === 'string') {
      // TODO: Is it faster moving `new TextEncoder()` outside the class and reusing the instance?
      data = str2bin(data);
    }
    return new Hash(hasher(data));
  }

  // TODO: Eliminate this monstrosity
  // It's slightly insecure because we don't lenght-prefix the parts
  public static digestParts(...parts: (Hash | Uint8Array | string | number)[]) {
    return Hash.digest(
      arrConcat(
        ...parts.map((p) =>
          p instanceof Hash
            ? p.toBytes()
            : p instanceof Uint8Array || typeof p === 'string'
            ? Hash.digest(p).toBytes()
            : arrFromNumber(p, 8)
        ),
      ),
    );
  }

  public static random() {
    const data = new Uint8Array(HASH_SIZE);
    crypto.getRandomValues(data);
    return new Hash(data);
  }

  public toBytes() {
    return this.digest;
  }

  public toHex() {
    return this.hex;
    // return bin2hex(this.digest);
  }

  public toBigint() {
    const view = new DataView(this.digest.buffer);
    return (view.getBigUint64(0) << 192n) | (view.getBigUint64(8) << 128n) |
      (view.getBigUint64(16) << 64n) | view.getBigUint64(24);
  }

  // TODO: Use global Map + FinalizationRegistry to make the Hash object a unique primitive
  public toPrimitive() {
    return this.toHex();
    // return this.toBigint();
  }

  public static composePrimitives(
    a: HashPrimitive & (string | bigint),
    b: HashPrimitive & (string | bigint),
  ) {
    return a + b;
    // return (a << 1n) ^ b;
  }

  public countLeadingZeros() {
    let count = 0;
    for (const b of this.digest) {
      for (let i = 0; i < 8; i++) {
        if ((b >> i) & 1) {
          return count;
        }
        count++;
      }
    }
    return count;
  }

  public population() {
    let pop = 0;
    for (const b of this.digest) {
      for (let i = 0; i < 8; i++) {
        pop += (b >> i) & 1;
      }
    }
    return pop;
  }

  public weightedPopulation(weightStart: number, weightEnd: number) {
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

  public increment() {
    const b = new Uint8Array(this.digest);
    for (let i = HASH_SIZE; i-- > 0;) {
      b[i]++;
      if (b[i] !== 0) {
        break;
      }
    }
    return Hash.fromBytes(b);
  }

  public bit(index: number) {
    return (this.digest[index >>> 3] >>> (index & 7)) & 1;
  }

  public static xor(h0: Hash, h1: Hash) {
    const res = new Uint8Array(HASH_SIZE);
    for (let i = 0; i < HASH_SIZE; i++) {
      res[i] = h0.digest[i] ^ h1.digest[i];
    }
    return Hash.fromBytes(res);
  }

  public static add(h0: Hash, h1: Hash) {
    const res = new Uint8Array(HASH_SIZE);
    let c = 0;
    for (let i = 0; i < HASH_SIZE; i++) {
      c += h0.digest[i] + h1.digest[i];
      res[i] = c;
      c >>>= 8;
    }
    return Hash.fromBytes(res);
  }

  public static combine(...hashes: Hash[]) {
    // TODO: Maybe there's a faster way to do this? Addition?
    return Hash.digest(arrConcat(...hashes.map((h) => h.toBytes())));
  }

  public static equals(h0: Hash, h1: Hash) {
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

  public static compare(h0: Hash, h1: Hash) {
    for (let i = 0; i < HASH_SIZE; i++) {
      if (h0.digest[i] < h1.digest[i]) {
        return -1;
      } else if (h0.digest[i] > h1.digest[i]) {
        return 1;
      }
    }
    return 0;
  }
}

export type HashPrimitive = ReturnType<Hash['toPrimitive']>;

export const ZERO_HASH = Hash.fromBytes(new Uint8Array(HASH_SIZE));
export const EMPTY_HASH = Hash.digest(new Uint8Array());
