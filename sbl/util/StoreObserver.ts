import Context from '../Context.ts';
import Hash, { HashPrimitive } from './Hash.ts';
import Store2 from './Store2.ts';

const observers: WeakMap<Store2<any>, StoreObserver<any>> = new WeakMap();

export default class StoreObserver<T> {
  private listeners: Map<HashPrimitive, ((val: T | undefined) => void)[]> =
    new Map();

  constructor(private store: Store2<T>) {
    store.onMutate((hash, _, val) =>
      this.listeners.get(hash.toPrimitive())?.forEach((cb) => cb(val))
    );
  }

  public static get<T>(store: Store2<T>) {
    let obs: StoreObserver<T> | undefined = observers.get(store);
    if (!obs) {
      obs = new StoreObserver(store);
      observers.set(store, obs);
    }
    return obs;
  }

  public observe(hash: Hash, cb: (val: T | undefined) => void) {
    const key = hash.toPrimitive();
    const listeners = this.listeners.get(key);
    if (listeners) {
      listeners.push(cb);
    } else {
      this.listeners.set(key, [cb]);
    }

    const val = this.store.get(hash);
    if (val !== undefined) {
      cb(val);
    }
  }

  public unobserve(hash: Hash, cb: (val: T | undefined) => void) {
    const key = hash.toPrimitive();
    const listeners = this.listeners.get(key);
    if (!listeners) {
      throw new Error(`No listeners exist for hash ${hash.toHex()}`);
    }
    const idx = listeners.indexOf(cb);
    if (idx === -1) {
      throw new Error(
        `Cannot find listener to unobserve for hash ${hash.toHex()}`,
      );
    }
    if (listeners.length === 1) {
      this.listeners.delete(key);
    } else {
      listeners.splice(idx, 1);
    }
  }
}
