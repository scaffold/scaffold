import { Timeout } from '../Config.ts';
import { Context } from '../Context.ts';
import { mapPut } from '../util/map.ts';

// export interface ReactiveRecordSet<RecordType> {
//   getAll(): Iterable<RecordType>;

//   onAdd(cb: (record: RecordType) => void): void;
//   offAdd(cb: (record: RecordType) => void): void;

//   onRemove(cb: (record: RecordType) => void): void;
//   offRemove(cb: (record: RecordType) => void): void;

//   onUpdate(record: RecordType, cb: (record: RecordType) => void): void;
//   offUpdate(record: RecordType, cb: (record: RecordType) => void): void;
// }

export abstract class ReactiveRecordSet<RecordType> {
  private addListeners: ((record: RecordType) => void)[] = [];
  private removeListeners: ((record: RecordType) => void)[] = [];
  private updateListeners = new Map<
    RecordType,
    ((record: RecordType) => void)[]
  >();

  private timeout?: Timeout;
  private debounces: (() => void)[] = [];

  constructor(protected ctx: Context) {}

  public abstract getAll(): Iterable<RecordType>;

  public onAdd(cb: (record: RecordType) => void) {
    this.addListeners.push(cb);
  }
  public offAdd(cb: (record: RecordType) => void) {
    const idx = this.addListeners.indexOf(cb);
    if (idx === -1) {
      throw new Error(`Cannot remove a non-existent callback!`);
    }
    this.addListeners.splice(idx, 1);
  }

  public onRemove(cb: (record: RecordType) => void) {
    this.removeListeners.push(cb);
  }
  public offRemove(cb: (record: RecordType) => void) {
    const idx = this.removeListeners.indexOf(cb);
    if (idx === -1) {
      throw new Error(`Cannot remove a non-existent callback!`);
    }
    this.removeListeners.splice(idx, 1);
  }

  public onUpdate(record: RecordType, cb: (record: RecordType) => void) {
    mapPut(this.updateListeners, record, () => []).push(cb);
  }
  public offUpdate(record: RecordType, cb: (record: RecordType) => void) {
    const listeners = this.updateListeners.get(record);
    if (listeners === undefined) {
      throw new Error(`Cannot remove a non-existent callback!`);
    }
    const idx = listeners.indexOf(cb);
    if (idx === -1) {
      throw new Error(`Cannot remove a non-existent callback!`);
    }
    listeners.splice(idx, 1);
  }

  public dispatchAdd(record: RecordType) {
    this.debounce(() => {
      for (const listener of this.addListeners) {
        listener(record);
      }
    });
  }

  public dispatchRemove(record: RecordType) {
    this.debounce(() => {
      for (const listener of this.removeListeners) {
        listener(record);
      }
    });
  }

  public dispatchUpdate(record: RecordType) {
    this.debounce(() => {
      const listeners = this.updateListeners.get(record);
      if (listeners !== undefined) {
        for (const listener of listeners) {
          listener(record);
        }
      }
    });
  }

  private debounce(cb: () => void) {
    this.debounces.push(cb);

    if (this.timeout === undefined) {
      this.timeout = this.ctx.config.timeProvider.setTimeout(() => {
        this.timeout = undefined;
        const debounces = this.debounces;
        this.debounces = [];
        for (const cb of debounces) {
          cb();
        }
      }, 10);
    }
  }
}
