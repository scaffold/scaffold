import { Sha256 } from 'https://deno.land/std@0.121.0/hash/sha256.ts';
import { bin2hex, hex2bin } from './hex.ts';
import Hash from './Hash.ts';

export interface HashMapEntry<V> {
  hash: Hash;
  val: V;
}

export default abstract class HashMap<V> {
  private map: Map<string, V> = new Map();

  // public get(key: K): V | undefined {
  //   return this.map.get(this.computeHash(key).toHex());
  // }

  protected getOrCreate(
    hash: Hash,
    creator: () => V,
    mutator?: (v: V) => V,
  ): HashMapEntry<V> {
    const hex = hash.toHex();
    let val = this.map.get(hex);
    if (!val) {
      val = creator();
      this.map.set(hex, val);
    } else if (mutator) {
      val = mutator(val);
      this.map.set(hex, val);
    }
    return { hash, val };
  }
}
