import { Hash } from './util/Hash.ts';

export class Fingerprinter {
  private mapping: number;

  constructor(seed: Hash, bytes: number) {
    let mapping = 0;
    for (let i = 0; i < 16; i++) {
      const byte = i < bytes
        ? i
        : ((seed.toBytes()[i * 2] << 8) | seed.toBytes()[i * 2 + 1]) % bytes;
      mapping |= byte << (i << 1);
    }
    this.mapping = mapping;
  }

  toBytes(dst: Uint8Array, hash: Hash) {
    for (let i = 0; i < 16; i++) {
      const byte = (this.mapping >>> (i << 1)) & 3;
      dst[byte] ^= hash.toBytes()[i];
    }
  }

  toFingerprint(hash: Hash) {
    let res = 0;
    for (let i = 0; i < 16; i++) {
      const byte = (this.mapping >>> (i << 1)) & 3;
      res ^= hash.toBytes()[i] << (byte << 3);
    }
    return res;
  }
}

export class FingerprintSet {
  private newArr = new Uint32Array(1);
  private newFingerprintBits = 0;

  private oldArr = new Uint32Array(1);
  private oldFingerprintBits = 0;

  private insertsLeft = 0;

  test(fingerprint: number) {
    return this.newArr[fingerprint & ((1 << this.newFingerprintBits) - 1)] ||
      this.oldArr[fingerprint & ((1 << this.oldFingerprintBits) - 1)];
  }

  add(fingerprints: Uint8Array, stride: number, value: number) {
    for (let i = 0; i < fingerprints.byteLength; i += stride) {
      if (this.insertsLeft === 0) {
        this.swap(stride * 8);
      }

      let num = 0;
      for (let j = 0; j < stride; j++) {
        num = (num << 8) | fingerprints[i + j];
      }
      this.newArr[num & (1 << this.newFingerprintBits)] = value;

      this.insertsLeft--;
    }
  }

  private swap(fingerprintSize: number) {
    this.oldArr = this.newArr;
    this.oldFingerprintBits = this.newFingerprintBits;

    if (fingerprintSize > this.newFingerprintBits) {
      // Only allow increasing by one
      this.newFingerprintBits++;
    }
    this.newArr = new Uint32Array(1 << this.newFingerprintBits);

    // TODO: Calculate this more accurately
    this.insertsLeft = this.newArr.length >>> 1;
  }
}
