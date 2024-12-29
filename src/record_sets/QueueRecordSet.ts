import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { mapPut } from '../util/map.ts';
import { Queue, QueueMuxer } from '../util/QueueMuxer.ts';
import { HashPrimitive } from '../util/Hash.ts';

export interface QueueRecord<Key, Value> {
  queue: Queue<Key, Value>;
  throughputCount: number;
}

export class QueueRecordSet<Key, Value> extends ReactiveRecordSet<QueueRecord<Key, Value>> {
  private records = new Map<HashPrimitive, QueueRecord<Key, Value>>();

  constructor(private muxer: QueueMuxer<Key, Value>) {
    super();
  }

  public update(
    hp: HashPrimitive,
    patch:
      & Partial<QueueRecord<Key, Value>>
      & Pick<QueueRecord<Key, Value>, 'queue'>,
    throughput: number,
  ) {
    mapPut(this.records, hp, () => {
      const rec = Object.assign({ throughputCount: 0 }, patch);
      this.dispatchAdd(rec);
      return rec;
    }, (rec) => {
      Object.assign(rec, patch);
      this.dispatchUpdate(rec);
      return rec;
    }).throughputCount += throughput;
  }

  public getAll(): Iterable<QueueRecord<Key, Value>> {
    for (const [hp, queue] of this.muxer.getQueues()) {
      this.update(hp, { queue }, 0);
    }
    return this.records.values();
  }
}
