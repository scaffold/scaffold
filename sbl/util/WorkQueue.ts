import { RBTree } from 'std-latest/collections/rb_tree.ts';
import Hash from './Hash.ts';

interface Entry {
  valuePerSecond: number;
  key: Hash;
  work(): Promise<void>;
}

export default class WorkQueue {
  private queue: RBTree<Entry> = new RBTree((a: Entry, b: Entry) =>
    a.valuePerSecond !== b.valuePerSecond
      ? a.valuePerSecond - b.valuePerSecond
      : Hash.cmp(a.key, b.key)
  );
  private map: Map<string, Entry> = new Map();
  private pausedWorkers: ((worker: () => Promise<void>) => void)[] = [];

  private runningWorkerCount = 0;
  private targetWorkerCount = 0;
  private onWorkerCountEqual = () => {};

  // TODO: Force option?
  public setWorkerCount(numWorkers: number) {
    // Resume any previously blocking setWorkerCount calls.
    this.onWorkerCountEqual();

    this.targetWorkerCount = numWorkers;
    while (this.runningWorkerCount < this.targetWorkerCount) {
      this.worker();
    }

    if (this.runningWorkerCount > this.targetWorkerCount) {
      // Wake paused workers up
      const stop = this.runningWorkerCount - this.targetWorkerCount;
      this.pausedWorkers.splice(-stop).forEach((cb) =>
        cb(() => Promise.resolve())
      );

      // Wait for workers to finish
      return new Promise<void>((resolve) => this.onWorkerCountEqual = resolve);
    }
  }

  public getRunningWorkerCount() {
    return this.runningWorkerCount;
  }
  public getTargetWorkerCount() {
    return this.targetWorkerCount;
  }

  public set(key: Hash, valuePerSecond: number, work: () => Promise<void>) {
    const entry = this.map.get(key.toHex());
    if (entry) {
      if (valuePerSecond !== entry.valuePerSecond) {
        this.queue.remove(entry);
        entry.valuePerSecond = valuePerSecond;
        entry.work = work;
        this.queue.insert(entry);
      }
    } else {
      const entry = { valuePerSecond, key, work };

      if (this.pausedWorkers.length) {
        this.pausedWorkers.pop()!(entry.work);
      } else {
        this.map.set(key.toHex(), entry);
        this.queue.insert(entry);
      }
    }
  }

  public remove(key: Hash) {
    const entry = this.map.get(key.toHex());
    if (entry) {
      this.queue.remove(entry);
      this.map.delete(key.toHex());
    }
  }

  public cleanup() {
    const maxSize = 1000;

    while (this.queue.size > maxSize) {
      const entry = this.queue.min()!;
      this.queue.remove(entry);
      this.map.delete(entry.key.toHex());
    }
  }

  private pop() {
    const entry = this.queue.max();
    if (entry) {
      this.queue.remove(entry);
      this.map.delete(entry.key.toHex());
      return entry.work;
    } else {
      return new Promise<() => Promise<void>>((resolve) =>
        this.pausedWorkers.push(resolve)
      );
    }
  }

  private async worker() {
    this.runningWorkerCount++;
    while (this.runningWorkerCount <= this.targetWorkerCount) {
      const work = await this.pop();
      await work();
    }
    this.runningWorkerCount--;
    if (this.runningWorkerCount === this.targetWorkerCount) {
      this.onWorkerCountEqual();
    }
  }
}
