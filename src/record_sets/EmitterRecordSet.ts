import { Context } from '../Context.ts';
import { EmitterItem, FactEmitter } from '../FactEmitter.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
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

  public update(patch: Partial<EmitterRecord> & Pick<EmitterRecord, 'item'>) {
    if (patch.weight === undefined || patch.weight > 0) {
      mapPut(this.records, patch.item, () => {
        const rec = Object.assign({}, recordBase, patch);
        this.dispatchAdd(rec);
        return rec;
      }, (rec) => {
        Object.assign(rec, patch);
        this.dispatchUpdate(rec);
        return rec;
      }).updates++;
    } else {
      const found = this.records.get(patch.item);
      if (found !== undefined) {
        this.dispatchRemove(found);
        this.records.delete(patch.item);
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
