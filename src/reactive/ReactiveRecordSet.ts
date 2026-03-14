/**
 * Reactive record set: abstract base class that notifies listeners when
 * records are added, removed, or updated. Dispatches are debounced by
 * default (10ms) to batch rapid updates into a single callback round.
 */
export interface ReactiveRecordSetConfig {
  /** Debounce interval in ms. Set to 0 for synchronous dispatch. Default: 10. */
  debounceMs?: number;
}

export abstract class ReactiveRecordSet<RecordType> {
  private addListeners: ((record: RecordType) => void)[] = [];
  private removeListeners: ((record: RecordType) => void)[] = [];
  private updateListeners = new Map<
    RecordType,
    ((record: RecordType) => void)[]
  >();

  private timeoutId?: ReturnType<typeof setTimeout>;
  private debounces: (() => void)[] = [];
  private readonly debounceMs: number;

  constructor(config?: ReactiveRecordSetConfig) {
    this.debounceMs = config?.debounceMs ?? 10;
  }

  public abstract getAll(): Iterable<RecordType>;

  // -- Add listeners --

  public onAdd(cb: (record: RecordType) => void): void {
    this.addListeners.push(cb);
  }

  public offAdd(cb: (record: RecordType) => void): void {
    const idx = this.addListeners.indexOf(cb);
    if (idx !== -1) this.addListeners.splice(idx, 1);
  }

  // -- Remove listeners --

  public onRemove(cb: (record: RecordType) => void): void {
    this.removeListeners.push(cb);
  }

  public offRemove(cb: (record: RecordType) => void): void {
    const idx = this.removeListeners.indexOf(cb);
    if (idx !== -1) this.removeListeners.splice(idx, 1);
  }

  // -- Update listeners (per-record) --

  public onUpdate(record: RecordType, cb: (record: RecordType) => void): void {
    let listeners = this.updateListeners.get(record);
    if (!listeners) {
      listeners = [];
      this.updateListeners.set(record, listeners);
    }
    listeners.push(cb);
  }

  public offUpdate(record: RecordType, cb: (record: RecordType) => void): void {
    const listeners = this.updateListeners.get(record);
    if (!listeners) return;
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
    if (listeners.length === 0) this.updateListeners.delete(record);
  }

  // -- Dispatch methods --

  protected dispatchAdd(record: RecordType): void {
    this.debounce(() => {
      for (const listener of this.addListeners) {
        listener(record);
      }
    });
  }

  protected dispatchRemove(record: RecordType): void {
    this.debounce(() => {
      for (const listener of this.removeListeners) {
        listener(record);
      }
    });
  }

  protected dispatchUpdate(record: RecordType): void {
    this.debounce(() => {
      const listeners = this.updateListeners.get(record);
      if (listeners) {
        for (const listener of listeners) {
          listener(record);
        }
      }
    });
  }

  // -- Lifecycle --

  /** Clear all listeners and pending timeouts. */
  public dispose(): void {
    this.addListeners.length = 0;
    this.removeListeners.length = 0;
    this.updateListeners.clear();
    this.debounces.length = 0;
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }

  // -- Internals --

  private debounce(cb: () => void): void {
    this.debounces.push(cb);

    if (this.timeoutId === undefined) {
      if (this.debounceMs === 0) {
        // Synchronous dispatch (for testing)
        this.flush();
      } else {
        this.timeoutId = setTimeout(() => {
          this.timeoutId = undefined;
          this.flush();
        }, this.debounceMs);
      }
    }
  }

  private flush(): void {
    const batch = this.debounces;
    this.debounces = [];
    for (const cb of batch) {
      cb();
    }
  }
}
