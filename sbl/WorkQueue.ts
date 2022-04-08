import { RBTree } from 'std-latest/collections/rb_tree.ts';

import Context from './Context.ts';
import Hash from './util/Hash.ts';

interface Entry {
  valuePerSecond: number;
  index: number;
  work(): Promise<void>;
}

let nextIdx = 0;

export default class QuestionService {
  private queue: RBTree<Entry> = new RBTree((a: Entry, b: Entry) =>
    a.valuePerSecond !== b.valuePerSecond
      ? a.valuePerSecond - b.valuePerSecond
      : a.index - b.index
  );
  private map: Map<string, Entry> = new Map();

  constructor(private ctx: Context) {}

  set(key: Hash, valuePerSecond: number, work: () => Promise<void>) {
    const entry = this.map.get(key.toHex());
    if (entry) {
      if (valuePerSecond !== entry.valuePerSecond) {
        this.queue.remove(entry);
        entry.valuePerSecond = valuePerSecond;
        entry.work = work;
        this.queue.insert(entry);
      }
    } else {
      const entry = { valuePerSecond, index: nextIdx++, work };
      this.map.set(key.toHex(), entry);
      this.queue.insert(entry);
    }
  }
}
