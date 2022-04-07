import { Sha256 } from 'https://deno.land/std@0.121.0/hash/sha256.ts';
import { bin2hex, hex2bin } from './hex.ts';
import Hash from './Hash.ts';

export default abstract class HashMap<V> {
  private map: Map<string, V> = new Map();

  protected get(hash: Hash): V | undefined {
    return this.map.get(hash.toHex());
  }

  protected getOrCreate(
    hash: Hash,
    creator: () => V,
    mutator?: (v: V) => V,
  ) {
    const hex = hash.toHex();
    let val = this.map.get(hex);
    if (!val) {
      val = creator();
      this.map.set(hex, val);
    } else if (mutator) {
      val = mutator(val);
      this.map.set(hex, val);
    }
    return val;
  }
}
