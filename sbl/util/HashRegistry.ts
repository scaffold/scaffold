import Context from '../Context.ts';
import Hash, { HashPrimitive } from './Hash.ts';

export default abstract class HashRegistry<V> {
  private map: Map<HashPrimitive, V> = new Map();
  private listeners: Map<HashPrimitive, ((value: V) => void)[]> = new Map();

  constructor(private ctx: Context) {
    // setInterval(() => {
    //   console.log(this.constructor.name, this.map.size);
    // }, 60000);
  }

  public size() {
    return this.map.size;
  }
  public getAll() {
    return Array.from(
      this.map,
      ([key, val]) => ({ key: Hash.fromPrimitive(key), val }),
    );
  }

  public debugGetAll() {
    return this.map;
  }

  public get(hash: Hash): V | undefined {
    return this.map.get(hash.toPrimitive());
  }

  public getOrWait(hash: Hash): V | Promise<V> {
    const key = hash.toPrimitive();
    const val = this.map.get(key);
    if (val) {
      return val;
    } else {
      return new Promise((resolve) => {
        const ls = this.listeners.get(key);
        if (ls) {
          ls.push(resolve);
        } else {
          this.listeners.set(key, [resolve]);
        }
      });
    }
  }

  public getOrCreate(
    hash: Hash,
    creator: () => V,
    mutator?: (v: V) => V,
  ) {
    const hex = hash.toPrimitive();
    let val = this.map.get(hex);
    if (!val) {
      val = creator();
      this.map.set(hex, val);
      const ls = this.listeners.get(hex);
      if (ls) {
        this.listeners.delete(hex);
        ls.forEach((l) => l(val!));
      }
    } else if (mutator) {
      val = mutator(val);
      this.map.set(hex, val);
    }
    return val;
  }

  public pop(hash: Hash) {
    const hex = hash.toPrimitive();
    const val = this.map.get(hex);
    if (val) {
      this.map.delete(hex);
    }
    return val;
  }
}
