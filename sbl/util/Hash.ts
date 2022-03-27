import { Sha256 } from 'https://deno.land/std@0.121.0/hash/sha256.ts';
import { bin2hex, hex2bin } from './hex.ts';

export default class Hash {
  public static fromBytes(bytes: Uint8Array) {
    return new Hash(bytes);
  }

  public static fromHex(hex: string) {
    return new Hash(hex2bin(hex));
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

  public static digest(data: Uint8Array | string) {
    if (typeof data === 'string') {
      const encoder = new TextEncoder();
      data = encoder.encode(data);
    }
    const algo = new Sha256();
    algo.update(data);
    // const digest = await crypto.subtle.digest('SHA-256', data);
    return new Hash(new Uint8Array(algo.arrayBuffer()));
  }

  public static random() {
    const data = new Uint8Array(32);
    crypto.getRandomValues(data);
    return new Hash(data);
  }

  private constructor(private digest: Uint8Array) {
    if (digest.length !== 32) {
      throw new Error(`Invalid digest length`);
    }
  }

  public toBytes() {
    return this.digest;
  }

  public toHex() {
    return bin2hex(this.digest);
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
    for (let i = 32; i-- > 0;) {
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
    const res = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      res[i] = h0.digest[i] ^ h1.digest[i];
    }
    return Hash.fromBytes(res);
  }

  public static equals(h0: Hash, h1: Hash) {
    for (let i = 0; i < 32; i++) {
      if (h0.digest[i] !== h1.digest[i]) {
        return false;
      }
    }
    return true;
  }

  public static cmp(h0: Hash, h1: Hash) {
    for (let i = 0; i < 32; i++) {
      if (h0.digest[i] < h1.digest[i]) {
        return -1;
      } else if (h0.digest[i] > h1.digest[i]) {
        return 1;
      }
    }
    return 0;
  }
}
