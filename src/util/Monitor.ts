import Hash, { HashPrimitive } from './Hash.ts';
import { getOrCreate } from './map.ts';

class Monitor<Value, Key> {
  private listeners = new Map<HashPrimitive, ((value: Value) => boolean)[]>();

  constructor(private keyFn: (key: Key) => Hash) {}

  public on(key: Key, cb: (value: Value) => boolean) {
    const hp = this.keyFn(key).toPrimitive();
    getOrCreate(this.listeners, hp, () => []).push(cb);
  }

  public off(key: Key, cb: (value: Value) => boolean) {
    const hp = this.keyFn(key).toPrimitive();
    const listeners = getOrCreate(this.listeners, hp, () => []);
    const idx = listeners.lastIndexOf(cb);
    if (idx === -1) {
      throw new Error(`Listener does not exist`);
    }
    listeners.splice(idx, 1);
  }

  protected resolveOne(key: Key, value: Value) {
    const hp = this.keyFn(key).toPrimitive();
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

  protected resolveAll(key: Key, value: Value) {
    const hp = this.keyFn(key).toPrimitive();
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

  protected callAll(key: Key, value: Value) {
    const hp = this.keyFn(key).toPrimitive();
    const listeners = this.listeners.get(hp);
    if (listeners !== undefined) {
      for (const l of listeners) {
        l(value);
      }
    }
  }
}

export class ResolvingMonitor<Value, Key> extends Monitor<Value, Key> {
  public waitFor(
    key: Key,
    until: AbortSignal,
    filter?: (value: Value) => boolean,
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

  public override resolveOne(key: Key, value: Value) {
    return super.resolveOne(key, value);
  }
  public override resolveAll(key: Key, value: Value) {
    super.resolveAll(key, value);
  }
}

export class WatchingMonitor<Value, Key> extends Monitor<Value, Key> {
  public override callAll(key: Key, value: Value) {
    super.callAll(key, value);
  }
}
