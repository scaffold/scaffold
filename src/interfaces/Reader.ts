import { MaybePromise } from '../util/MaybePromise.ts';
import { ValueType } from '../contracts/Contract.ts';

interface NullReader {
  type: ValueType.Null;
}
interface BoolReader {
  type: ValueType.Bool;
  value: boolean;
}
interface NumberReader {
  type: ValueType.Number;
  value: number;
}
interface BytesReader {
  type: ValueType.Bytes;
  value: Uint8Array;
}
interface StringReader {
  type: ValueType.String;
  value: string;
}
interface ArrayReader {
  type: ValueType.Array;
  length: number;
  at(index: number, descriptor: string): MaybePromise<Reader>;
}
interface ObjectReader {
  type: ValueType.Object;
  keys: string[];
  at(key: string, descriptor: string): MaybePromise<Reader>;
}
export type Reader =
  | NullReader
  | BoolReader
  | NumberReader
  | BytesReader
  | StringReader
  | ArrayReader
  | ObjectReader;

export function createReader(value: unknown): Reader {
  switch (typeof value) {
    case 'undefined':
      return { type: ValueType.Null };
    case 'boolean':
      return { type: ValueType.Bool, value };
    case 'number':
      return { type: ValueType.Number, value };
    case 'string':
      return { type: ValueType.String, value };
    case 'object':
      if (value === null) return { type: ValueType.Null };
      else if (value instanceof Uint8Array) return { type: ValueType.Bytes, value };
      else if (Array.isArray(value)) {
        return {
          type: ValueType.Array,
          length: value.length,
          at: (idx, _desc) => createReader(value[idx]),
        };
      } else {
        return {
          type: ValueType.Object,
          keys: Object.keys(value),
          at: (key, _desc) => createReader((value as Record<string, unknown>)[key]),
        };
      }
    default:
      throw new Error(`Unsupported type ${typeof value}`);
  }
}
