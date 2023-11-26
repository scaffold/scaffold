import { HashPrimitive, ZERO_HASH } from '~/sbl/util/Hash.ts';

if (typeof ZERO_HASH === 'number') {
  throw new Error(`Hash primitive can't be a number!`);
}

export default class BytesMap<T> {
  private map = new Map<number | HashPrimitive, T>();

  public get(key: Uint8Array) {
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
