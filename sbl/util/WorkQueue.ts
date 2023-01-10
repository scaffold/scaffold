import { RedBlackTree } from 'std-latest/collections/red_black_tree.ts';
import Hash from './Hash.ts';

const STATE_QUEUED = 0 as const;
const STATE_RUNNING = 1 as const;
const STATE_PAUSED = 2 as const;
const STATE_FINISHED = 3 as const;
type EntryState =
  | typeof STATE_QUEUED
  | typeof STATE_RUNNING
  | typeof STATE_PAUSED
  | typeof STATE_FINISHED;

export type WorkFn = (pause: () => void, resume: () => void) => Promise<void>;

interface Entry {
  hash: Hash;
  valuePerSecond: number;
  state: EntryState;
  work: WorkFn;
}

const wakeupEntry: Entry = {
  hash: Hash.fromLiteral32(0),
  valuePerSecond: 0,
  state: STATE_QUEUED,
  work: () => Promise.resolve(),
};

const setState = (entry: Entry, from: EntryState, to: EntryState) => {
  if (entry.state !== from) {
    throw new Error(`Incorrect state; ${entry.state}, but should be ${from}!`);
  }
  entry.state = to;
};

export default class WorkQueue {
  private queue: RedBlackTree<Entry> = new RedBlackTree((a, b) =>
    a.valuePerSecond !== b.valuePerSecond
      ? a.valuePerSecond - b.valuePerSecond
      : Hash.cmp(a.hash, b.hash)
  );
  // TODO: Cleanup map after some time
  private map: Map<string, Entry> = new Map();
  private pausedWorkers: ((entry: Entry) => void)[] = [];

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
      this.pausedWorkers.splice(-stop).forEach((cb) => cb(wakeupEntry));

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

  public set(hash: Hash, valuePerSecond: number, work: WorkFn) {
    const key = hash.toHex();
    const entry = this.map.get(key);
    if (entry) {
      if (
        entry.state === STATE_QUEUED && valuePerSecond !== entry.valuePerSecond
      ) {
        this.queue.remove(entry);
        if (valuePerSecond > 0) {
          entry.valuePerSecond = valuePerSecond;
          entry.work = work;
          this.queue.insert(entry);
        }
      }
    } else {
      const entry = { hash, valuePerSecond, state: STATE_QUEUED, work };
      this.map.set(key, entry);

      if (this.pausedWorkers.length) {
        this.pausedWorkers.pop()!(entry);
      } else {
        this.queue.insert(entry);
      }
    }
  }

  public remove(hash: Hash) {
    const entry = this.map.get(hash.toHex());
    if (entry) {
      this.queue.remove(entry);
      this.map.delete(hash.toHex());
    }
  }

  public cleanup(maxSize = 1000) {
    while (this.queue.size > maxSize) {
      const entry = this.queue.min()!;
      this.queue.remove(entry);
      this.map.delete(entry.hash.toHex());
    }
  }

  private pop() {
    const entry = this.queue.max();
    if (entry) {
      this.queue.remove(entry);
      return entry;
    } else {
      return new Promise<Entry>((resolve) => this.pausedWorkers.push(resolve));
    }
  }

  private async worker() {
    this.runningWorkerCount++;
    while (this.runningWorkerCount <= this.targetWorkerCount) {
      const entry = await this.pop();
      setState(entry, STATE_QUEUED, STATE_RUNNING);
      await entry.work(
        () => setState(entry, STATE_RUNNING, STATE_PAUSED),
        () => setState(entry, STATE_PAUSED, STATE_RUNNING),
      );
      setState(entry, STATE_RUNNING, STATE_FINISHED);
    }
    this.runningWorkerCount--;
    if (this.runningWorkerCount === this.targetWorkerCount) {
      this.onWorkerCountEqual();
    }
  }
}
