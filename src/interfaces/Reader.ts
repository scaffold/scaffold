import { MaybePromise } from '../util/MaybePromise.ts';
import { ValueType } from '../contracts/Contract.ts';

export interface NullReader {
  type: ValueType.Null;
}
export interface BoolReader {
  type: ValueType.Bool;
  value: boolean;
}
export interface NumberReader {
  type: ValueType.Number;
  value: number;
}
export interface BytesReader {
  type: ValueType.Bytes;
  value: Uint8Array;
}
export interface StringReader {
  type: ValueType.String;
  value: string;
}
export interface ArrayReader {
  type: ValueType.Array;
  length: number;
  at(index: number, descriptor: string): MaybePromise<Reader>;
}
export interface ObjectReader {
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

// TODO(claude): How can we make this infer the correct return type for constant inputs?
export function createReader<T extends unknown>(value: T) {
  switch (typeof value) {
    case 'undefined':
      return { type: ValueType.Null } satisfies NullReader;
    case 'boolean':
      return { type: ValueType.Bool, value } satisfies BoolReader;
    case 'number':
      return { type: ValueType.Number, value } satisfies NumberReader;
    case 'string':
      return { type: ValueType.String, value } satisfies StringReader;
    case 'object':
      if (value === null) return { type: ValueType.Null } satisfies NullReader;
      else if (value instanceof Uint8Array) {
        return { type: ValueType.Bytes, value } satisfies BytesReader;
      } else if (Array.isArray(value)) {
        return {
          type: ValueType.Array,
          length: value.length,
          at: (idx, _desc): Reader => createReader(value[idx]),
        } satisfies ArrayReader;
      } else {
        return {
          type: ValueType.Object,
          keys: Object.keys(value),
          at: (key, _desc): Reader => createReader((value as Record<string, unknown>)[key]),
        } satisfies ObjectReader;
      }
    default:
      throw new Error(`Unsupported type ${typeof value}`);
  }
}
