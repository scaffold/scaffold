import { Context } from '../Context.ts';
import { EmitterItem, FactEmitter } from '../FactEmitter.ts';
import { ReactiveRecordSet } from '../util/ReactiveRecordSet.ts';
import { mapPut } from '../util/map.ts';

export interface EmitterRecord {
  item: EmitterItem;
  value: number;
  size: number;
  throttle?: number;
  weight: number;
  updates: number;
  skips: number;
  emits: number;
}
const recordBase: Omit<EmitterRecord, 'item'> = {
  value: 0,
  size: 0,
  weight: 0,
  updates: 0,
  skips: 0,
  emits: 0,
};

export class EmitterRecordSet extends ReactiveRecordSet<EmitterRecord> {
  private records = new Map<EmitterItem, EmitterRecord>();

  constructor(private ctx: Context) {
    super();
  }

  public update(update: Partial<EmitterRecord> & Pick<EmitterRecord, 'item'>) {
    if (update.weight === undefined || update.weight > 0) {
      mapPut(this.records, update.item, () => {
        const rec = Object.assign({}, recordBase, update);
        this.dispatchAdd(rec);
        return rec;
      }, (rec) => {
        Object.assign(rec, update);
        this.dispatchUpdate(rec);
        return rec;
      }).updates++;
    } else {
      const found = this.records.get(update.item);
      if (found !== undefined) {
        this.dispatchRemove(found);
        this.records.delete(update.item);
      }
    }
  }

  public incrementSkip(item: EmitterItem) {
    mapPut(this.records, item, () => Object.assign({}, recordBase)).skips++;
  }

  public incrementEmit(item: EmitterItem) {
    mapPut(this.records, item, () => Object.assign({}, recordBase)).emits++;
  }

  public getAll(): Iterable<EmitterRecord> {
    for (const item of this.ctx.get(FactEmitter).getAll()) {
      // This will call this.update()
      this.ctx.get(FactEmitter).weight(item);
    }
    return this.records.values();
  }
}
