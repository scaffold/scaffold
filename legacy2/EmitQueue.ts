import { Connection } from './Connection.ts';
import { Fact } from './FactMeta.ts';
import { BinaryHeap } from '@std/data-structures';

export class EmitQueue {
  private queue = new BinaryHeap<Fact>();

  constructor(private conn: Connection) {}

  update(fact: Fact) {
    this.queue.push(fact);
  }

  emit() {
    const fact = this.queue.pop();
    if (fact === undefined) {
      return;
    }

    this.conn.sendReliable(fact.data);
  }
}
