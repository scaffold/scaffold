export interface ReactiveRecordSet<RecordType> {
  getAll(): Iterable<RecordType>;

  onAdd(cb: (record: RecordType) => void): void;
  offAdd(cb: (record: RecordType) => void): void;

  onRemove(cb: (record: RecordType) => void): void;
  offRemove(cb: (record: RecordType) => void): void;

  onUpdate(record: RecordType, cb: (record: RecordType) => void): void;
  offUpdate(record: RecordType, cb: (record: RecordType) => void): void;
}
