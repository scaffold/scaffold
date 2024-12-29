import { HashPrimitive } from './Hash.ts';
import { getOrCreate } from './map.ts';

// TODO: Change these to take AbortSiganls, and remove off() methods.

class Monitor<Key, Callback extends (...args: never[]) => void> {
  protected listeners = new Map<HashPrimitive, Callback[]>();

  constructor(protected keyFn: (key: Key) => HashPrimitive) {}

  public on(key: Key, cb: Callback) {
    const hp = this.keyFn(key);
    getOrCreate(this.listeners, hp, () => []).push(cb);
    return { release: () => this.off(key, cb) };
  }

  public off(key: Key, cb: Callback) {
    const hp = this.keyFn(key);
    const listeners = this.listeners.get(hp);
    if (listeners === undefined) {
      throw new Error(`Release called twice!`);
    }
    const idx = listeners.lastIndexOf(cb);
    if (idx === -1) {
      throw new Error(`Release called twice!`);
    }
    if (listeners.length === 1) {
      this.listeners.delete(hp);
    } else {
      listeners.splice(idx, 1);
    }
  }
}

export class ResolvingMonitor<Key, Value> extends Monitor<Key, (arg: Value) => boolean> {
  public waitFor(
    key: Key,
    until: AbortSignal,
    filter?: (val: Value) => boolean,
  ) {
    return new Promise<Value>((resolve) => {
      if (!until.aborted) {
        let needsCancel = true;
        const cb = (val: Value) => {
          if (filter === undefined || filter(val)) {
            needsCancel = false;
            resolve(val);
            return true;
          } else {
            return false;
          }
        };
        super.on(key, cb);
        until.addEventListener(
          'abort',
          () => needsCancel && super.off(key, cb),
        );
      }
    });
  }

  public resolveOne(key: Key, value: Value) {
    const hp = this.keyFn(key);
    const listeners = this.listeners.get(hp);
    if (listeners !== undefined) {
      for (let i = 0; i < listeners.length; i++) {
        if (listeners[i](value)) {
          if (listeners.length === 1) {
            this.listeners.delete(hp);
          } else {
            listeners.splice(i, 1);
          }
          return true;
        }
      }
    }

    return false;
  }

  public resolveAll(key: Key, value: Value) {
    const hp = this.keyFn(key);
    let listeners = this.listeners.get(hp);
    if (listeners !== undefined) {
      listeners = listeners.filter((l) => !l(value));
      if (listeners.length === 0) {
        this.listeners.delete(hp);
      } else {
        this.listeners.set(hp, listeners);
      }
    }
  }
}

export class WatchingMonitor<Key, Callback extends (...args: never[]) => void>
  extends Monitor<Key, Callback> {
  public callAll(key: Key, ...values: Parameters<Callback>) {
    const hp = this.keyFn(key);
    const listeners = this.listeners.get(hp);
    if (listeners !== undefined) {
      for (const l of listeners) {
        l(...values);
      }
    }
  }
}
