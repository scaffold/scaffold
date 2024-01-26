import { Hash, HASH_SIZE, HashPrimitive, ZERO_HASH } from './Hash.ts';
import { bin2hex } from './hex.ts';
import { MapSpec } from './map.ts';

if (typeof ZERO_HASH.toPrimitive() === 'number') {
  throw new Error(`Hash primitive can't be a number!`);
}

export class BytesMap<T> implements MapSpec<Uint8Array, T> {
  private map = new Map<number | HashPrimitive, T>();

  private toPrimitive(key: Uint8Array) {
    if (key.byteLength < HASH_SIZE) {
      return bin2hex(key);
    } else {
      return Hash.digest(key).toPrimitive();
    }
  }

  public get(key: Uint8Array) {
    return this.map.get(this.toPrimitive(key));
  }

  public set(key: Uint8Array, value: T) {
    this.map.set(this.toPrimitive(key), value);
  }

  public delete(key: Uint8Array) {
    return this.map.delete(this.toPrimitive(key));
  }

  private checksum(key: Uint8Array) {
    if (key.byteLength === 0) {
      return 0;
    }
    let sum = key[key.byteLength >>> 2];
    sum <<= 8;
    sum |= key[key.byteLength >>> 1];
    sum <<= 8;
    sum |= key[(key.byteLength * 3) >>> 2];
    sum <<= 8;
    sum |= key[key.byteLength - 1];
    return sum;
  }
}
