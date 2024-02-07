import { HashPrimitive } from './Hash.ts';
import { getOrCreate } from './map.ts';

export class Queue<Key, Value> {
  protected queues = new Map<HashPrimitive, {
    key: Key; // TODO: Remove; it's just for debugging
    pending: Value[];
    handlers: {
      filter(value: Value): boolean;
      resolve(value: Value): void;
    }[];
  }>();

  constructor(protected keyFn: (key: Key) => HashPrimitive) {}

  public pop(key: Key, filter: (value: Value) => boolean) {
    const hp = this.keyFn(key);
    const queue = this.queues.get(hp);
    if (queue === undefined) {
      return;
    }

    for (let i = 0; i < queue.pending.length; i++) {
      if (filter(queue.pending[i])) {
        return queue.pending.splice(i, 1)[0];
      }
    }
  }

  public popAll(key: Key, filter: (value: Value) => boolean) {
    const hp = this.keyFn(key);
    const queue = this.queues.get(hp);
    if (queue === undefined) {
      return [];
    }

    const res: Value[] = [];
    for (let i = 0; i < queue.pending.length; i++) {
      if (filter(queue.pending[i])) {
        res.push(queue.pending.splice(i, 1)[0]);
        i--;
      }
    }

    return res;
  }

  public waitFor(
    key: Key,
    until: AbortSignal,
    filter: (value: Value) => boolean,
  ) {
    return new Promise<Value>((resolve) => {
      const hp = this.keyFn(key);
      const queue = getOrCreate(
        this.queues,
        hp,
        () => ({ key, pending: [], handlers: [] }),
      );

      for (let i = 0; i < queue.pending.length; i++) {
        if (filter(queue.pending[i])) {
          resolve(queue.pending.splice(i, 1)[0]);
          return;
        }
      }

      const handler = { filter, resolve };
      queue.handlers.push(handler);
      until.addEventListener('abort', () => {
        const idx = queue.handlers.indexOf(handler);
        if (idx !== -1) {
          queue.handlers.splice(idx, 1);
        }
      });
    });
  }

  public insert(key: Key, value: Value) {
    const hp = this.keyFn(key);
    const queue = getOrCreate(
      this.queues,
      hp,
      () => ({ key, pending: [], handlers: [] }),
    );
    for (let i = 0; i < queue.handlers.length; i++) {
      if (queue.handlers[i].filter(value)) {
        queue.handlers.splice(i, 1)[0].resolve(value);
        return;
      }
    }
    queue.pending.push(value);
  }

  public remove(key: Key, valueOrPred: Value | ((value: Value) => boolean)) {
    const hp = this.keyFn(key);
    const queue = this.queues.get(hp);
    if (queue === undefined) {
      return false;
    }
    const idx = valueOrPred instanceof Function
      ? queue.pending.findIndex(valueOrPred)
      : queue.pending.indexOf(valueOrPred);
    if (idx !== -1) {
      queue.pending.splice(idx, 1);
      return true;
    } else {
      return false;
    }
  }

  public cleanup() {
    for (const [key, queue] of this.queues) {
      if (queue.pending.length === 0 && queue.handlers.length === 0) {
        this.queues.delete(key);
      }
    }
  }
}
