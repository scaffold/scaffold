import { MaybePromise } from '../util/MaybePromise.ts';
import { ValueDescriptor, ValueType } from './values.ts';

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

// Overloads so a statically-known input infers its concrete Reader variant
// (e.g. `createReader(5)` is typed `NumberReader`); `unknown`/`any` inputs fall
// back to the `Reader` union.
export function createReader(value: undefined | null): NullReader;
export function createReader(value: boolean): BoolReader;
export function createReader(value: number): NumberReader;
export function createReader(value: string): StringReader;
export function createReader(value: Uint8Array): BytesReader;
export function createReader(value: readonly unknown[]): ArrayReader;
export function createReader(value: object): ObjectReader;
export function createReader(value: unknown): Reader;
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
          at: (idx, _desc): Reader => createReader(value[idx]),
        };
      } else {
        return {
          type: ValueType.Object,
          keys: Object.keys(value),
          at: (key, _desc): Reader => createReader((value as Record<string, unknown>)[key]),
        };
      }
    default:
      throw new Error(`Unsupported type ${typeof value}`);
  }
}

// -- Field readers ---------------------------------------------------
//
// Helpers for a TS contract building params/data from a query Reader. The
// contract just holds child nodes in locals to descend (no cursor); the
// descriptor is forwarded to `at()` so a RecordingReader can capture it for the
// UI schema. A missing/wrong-typed field yields that type's empty default.

/** Resolve a named child of an object Reader, or a Null reader otherwise. */
export function readField(
  node: Reader,
  key: string,
  desc: ValueDescriptor,
): MaybePromise<Reader> {
  if (node.type !== ValueType.Object) return { type: ValueType.Null };
  return node.at(key, JSON.stringify(desc));
}

export async function readBytes(
  node: Reader,
  key: string,
  desc: ValueDescriptor,
): Promise<Uint8Array> {
  const child = await readField(node, key, desc);
  return child.type === ValueType.Bytes ? child.value : new Uint8Array(0);
}

export async function readString(
  node: Reader,
  key: string,
  desc: ValueDescriptor,
): Promise<string> {
  const child = await readField(node, key, desc);
  return child.type === ValueType.String ? child.value : '';
}

export async function readNumber(
  node: Reader,
  key: string,
  desc: ValueDescriptor,
): Promise<number> {
  const child = await readField(node, key, desc);
  return child.type === ValueType.Number ? child.value : 0;
}
