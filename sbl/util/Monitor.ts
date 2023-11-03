import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { getOrCreate } from '~/sbl/util/map.ts';

class Monitor<Value, Key> {
  private listeners = new Map<HashPrimitive, ((value: Value) => void)[]>();

  constructor(private keyFn: (key: Key) => Hash) {}

  public on(key: Key, cb: (value: Value) => void) {
    const hp = this.keyFn(key).toPrimitive();
    getOrCreate(this.listeners, hp, () => []).push(cb);
  }

  public off(key: Key, cb: (value: Value) => void) {
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
      if (listeners.length === 1) {
        this.listeners.delete(hp);
        listeners[0](value);
      } else {
        listeners.shift()!(value);
      }
      return true;
    } else {
      return false;
    }
  }

  protected resolveAll(key: Key, value: Value) {
    const hp = this.keyFn(key).toPrimitive();
    const listeners = this.listeners.get(hp);
    if (listeners !== undefined) {
      this.listeners.delete(hp);
      for (const l of listeners) {
        l(value);
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
  public waitFor(key: Key, until: AbortSignal) {
    return new Promise<Value>((resolve) => {
      if (!until.aborted) {
        let needsCancel = true;
        super.on(key, (val) => {
          needsCancel = false;
          resolve(val);
        });
        until.addEventListener(
          'abort',
          () => needsCancel && super.off(key, resolve),
        );
      }
    });
  }

  public resolveOne(key: Key, value: Value) {
    return super.resolveOne(key, value);
  }
  public resolveAll(key: Key, value: Value) {
    super.resolveAll(key, value);
  }
}

export class WatchingMonitor<Value, Key> extends Monitor<Value, Key> {
  public callAll(key: Key, value: Value) {
    super.callAll(key, value);
  }
}
