import { HashPrimitive } from './Hash.ts';
import { mapPut } from './map.ts';
import { QueueRecordSet } from '../record_sets/QueueRecordSet.ts';
import { assert } from '$std/assert/assert.ts';

export interface Queue<Key, Value> {
  key: Key; // TODO: Remove; it's just for debugging
  pending: Value[];
  handlers: {
    filter(value: Value): boolean;
    resolve(value: Value): void;
  }[];
}

export abstract class QueueMuxer<Key, Value> {
  private queues = new Map<HashPrimitive, Queue<Key, Value>>();

  constructor(protected keyFn: (key: Key) => HashPrimitive) {}

  protected abstract getRecordSet(): QueueRecordSet<Key, Value> | undefined;

  public getQueues() {
    return this.queues;
  }

  public insert(key: Key, value: Value) {
    const hp = this.keyFn(key);
    const queue = mapPut(
      this.queues,
      hp,
      () => ({ key, pending: [], handlers: [] }),
    );
    for (let i = 0; i < queue.handlers.length; i++) {
      if (queue.handlers[i].filter(value)) {
        queue.handlers.splice(i, 1)[0].resolve(value);
        this.getRecordSet()?.update(hp, { queue }, 1);
        return;
      }
    }
    queue.pending.push(value);
    this.getRecordSet()?.update(hp, { queue }, 0);
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
      this.getRecordSet()?.update(hp, { queue }, 0);
      return true;
    } else {
      return false;
    }
  }

  public pop(key: Key, filter: (value: Value) => boolean) {
    const hp = this.keyFn(key);
    const queue = this.queues.get(hp);
    if (queue === undefined) {
      return;
    }

    for (let i = 0; i < queue.pending.length; i++) {
      if (filter(queue.pending[i])) {
        const res = queue.pending.splice(i, 1)[0];
        this.getRecordSet()?.update(hp, { queue }, 1);
        return res;
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

    this.getRecordSet()?.update(hp, { queue }, res.length);

    return res;
  }

  public waitFor(
    key: Key,
    until: AbortSignal,
    filter: (value: Value) => boolean,
  ) {
    return new Promise<Value>((resolve) => {
      const hp = this.keyFn(key);
      const queue = mapPut(
        this.queues,
        hp,
        () => ({ key, pending: [], handlers: [] }),
      );

      for (let i = 0; i < queue.pending.length; i++) {
        if (filter(queue.pending[i])) {
          resolve(queue.pending.splice(i, 1)[0]);
          this.getRecordSet()?.update(hp, { queue }, 1);
          return;
        }
      }

      const handler = { filter, resolve };
      queue.handlers.push(handler);
      until.addEventListener('abort', () => {
        const idx = queue.handlers.indexOf(handler);
        if (idx !== -1) {
          const removed = queue.handlers.splice(idx, 1)[0];
          assert(removed === handler);
          this.getRecordSet()?.update(hp, { queue }, 0);
        }
      });
    });
  }

  public cleanup() {
    for (const [key, queue] of this.queues) {
      if (queue.pending.length === 0 && queue.handlers.length === 0) {
        this.queues.delete(key);
      }
    }
  }
}
