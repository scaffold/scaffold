import { MaybePromise } from '../util/MaybePromise.ts';

// The numeric values are wire ABI: scaffold_builder navigation imports return
// them to the guest. Never reorder.
export enum ValueType {
  Unit = 0,
  Bool = 1,
  Number = 2,
  String = 3,
  Bytes = 4,
  List = 5,
  Map = 6,
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
export interface MapSource {
  type: ValueType.Map;
  length?: number;
  entry(
    index: number,
    descriptor?: string,
  ): MaybePromise<{ key: string; value: Source } | undefined>;
  at(key: string, descriptor?: string): MaybePromise<Source | undefined>;
}

export type Source =
  | UnitSource
  | BoolSource
  | NumberSource
  | StringSource
  | BytesSource
  | ListSource
  | MapSource;
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
  setList(): ListSink | undefined; // Host should return undefined if they're not interested in descending into this collection
  setMap(): MapSink | undefined; // Host should return undefined if they're not interested in descending into this collection
}

export interface ListSink {
  at(index: number, descriptor?: string): ValueSink;
}

export interface MapSink {
  at(key: string, descriptor?: string): ValueSink;
}

export type SinkRoot = (descriptor?: string) => ValueSink;
