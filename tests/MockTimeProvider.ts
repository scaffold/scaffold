import { TimeProvider } from '../legacy2/Config.ts';
import { RedBlackTree } from '@std/data-structures';

// TODO: Use this instead? https://deno.land/std@0.208.0/testing/time.ts?s=FakeTime

interface Entry {
  timestamp: number;
  idx: number;
  cb(): void;
  requeueInterval?: number;
  stack: string;
}

export class MockTimeProvider implements TimeProvider {
  private queue: RedBlackTree<Entry> = new RedBlackTree((a, b) =>
    a.timestamp !== b.timestamp ? a.timestamp - b.timestamp : a.idx - b.idx
  );
  private entries: (Entry | undefined)[] = [undefined];

  constructor(private curTimestamp = 0) {}

  public destruct() {
    if (!this.queue.isEmpty()) {
      console.error(
        `Trying to destruct a MockTimeProvider but there's still ${this.queue.size} entries! Uncleared timeout set at:`,
        this.queue.min()!.stack,
      );
    }
  }

  public advanceTime(inc: number) {
    const newTimestamp = this.curTimestamp + inc;

    while (true) {
      const entry = this.queue.min();
      if (entry === null || entry.timestamp > newTimestamp) {
        break;
      }
      this.executeEntry(entry);
    }

    this.curTimestamp = newTimestamp;
  }

  public stepTime() {
    const entry = this.queue.min();
    if (entry !== null) {
      this.executeEntry(entry);
    }
  }

  private executeEntry(entry: Entry) {
    if (entry.timestamp > this.curTimestamp) {
      this.curTimestamp = entry.timestamp;
    }

    entry.cb();

    if (this.queue.remove(entry)) {
      if (entry.requeueInterval !== undefined) {
        entry.timestamp += entry.requeueInterval;
        this.queue.insert(entry);
      } else {
        this.entries[entry.idx] = undefined;
      }
    }
  }

  public now() {
    return Math.round(this.curTimestamp);
  }
  public setImmediate(cb: () => void) {
    this.enqueue(cb, 0);
  }
  public setTimeout(cb: () => void, delay: number) {
    return this.enqueue(cb, delay);
  }
  public clearTimeout(idx: number) {
    this.dequeue(idx, false);
  }
  public setInterval(cb: () => void, delay: number) {
    return this.enqueue(cb, delay, delay);
  }
  public clearInterval(idx: number) {
    this.dequeue(idx, true);
  }

  private enqueue(cb: () => void, delay: number, requeueInterval?: number) {
    const entry = {
      timestamp: this.curTimestamp + delay,
      idx: this.entries.length,
      cb,
      requeueInterval,
      stack: (new Error()).stack ?? '[none]',
    };

    this.queue.insert(entry);
    this.entries.push(entry);

    // console.log(
    //   `Enqueue ${entry.idx} with delay ${delay} and requeueInterval ${requeueInterval}`,
    // );

    return entry.idx;
  }

  private dequeue(idx: number, expectedRequeue: boolean) {
    // console.log(`Dequeue ${idx} with expectedRequeue ${expectedRequeue}`);

    const entry = this.entries[idx];
    if (entry) {
      if (expectedRequeue && entry.requeueInterval === undefined) {
        throw new Error(`Called clearInterval on an entry set by setTimeout`);
      } else if (!expectedRequeue && entry.requeueInterval !== undefined) {
        throw new Error(`Called clearTimeout on an entry set by setInterval`);
      }

      this.entries[idx] = undefined;
      this.queue.remove(entry);
    }
  }
}
