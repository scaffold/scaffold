import { MaybePromise } from '../util/MaybePromise.ts';

export enum ValueType {
  Unit,
  Bool,
  Number,
  String,
  Bytes,
  List,
  Struct,
}

/** Describes a field's type, purpose, and allowed values. */
export interface ValueDescriptor {
  /** MIME-ish type hierarchy, e.g. "bytes/public_key/ed25519". */
  type: string;
  /** Single-line summary shown as a label. */
  shortDescription: string;
  /** Optional multi-line markdown documentation. */
  markdownDescription?: string;
  /** If set, field is an enum -- host renders a selection UI. */
  options?: EnumOption[];
}

/** One allowed value in an enum field. */
export interface EnumOption {
  value: boolean | number | string;
  shortDescription: string;
  markdownDescription?: string;
}

// Types for building (WASM asks host for values)

export interface UnitSource {
  type: ValueType.Unit;
}
export interface BoolSource {
  type: ValueType.Bool;
  value: boolean;
}
export interface NumberSource {
  type: ValueType.Number;
  value: number;
}
export interface StringSource {
  type: ValueType.String;
  value: string;
}
export interface BytesSource {
  type: ValueType.Bytes;
  value: Uint8Array;
}
export interface ListSource {
  type: ValueType.List;
  length?: number;
  at(index: number, descriptor?: string): MaybePromise<Source | undefined>;
}
export interface StructSource {
  type: ValueType.Struct;
  at(key: string, descriptor?: string): MaybePromise<Source | undefined>;
}

export type Source =
  | UnitSource
  | BoolSource
  | NumberSource
  | StringSource
  | BytesSource
  | ListSource
  | StructSource;
// Maps should be represented as a list of key-value pairs.
// The descriptor can and should be used to specify the exact semantics of encodings like this.

export type SourceRoot = (descriptor?: string) => MaybePromise<Source | undefined>;

// Types for walking (WASM tells host values)

export interface ValueSink {
  setUnit(): void;
  setBool(value: boolean): void;
  setNumber(value: number): void;
  setString(value: string): void;
  setBytes(value: Uint8Array): void;
  setList(length?: number): ListSink | undefined; // Host should return undefined if they're not interested in descending into this collection
  setStruct(): StructSink | undefined; // Host should return undefined if they're not interested in descending into this collection
}

export interface ListSink {
  at(index: number, descriptor?: string): ValueSink;
}

export interface StructSink {
  at(key: string, descriptor?: string): ValueSink;
}

export type SinkRoot = (descriptor?: string) => ValueSink;
