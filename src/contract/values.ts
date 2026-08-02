import { MaybePromise } from '../util/MaybePromise.ts';

export enum ValueType {
  Null = 0,
  Bool = 1,
  Number = 2,
  String = 3,
  Bytes = 4,
  List = 5,
  Struct = 6,
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

// Maps should be represented as a list of key-value pairs
export interface BuilderHost {
  readNull(key: string | number, desc: ValueDescriptor): MaybePromise<void>;
  readBool(key: string | number, desc: ValueDescriptor): MaybePromise<boolean>;
  readNumber(key: string | number, desc: ValueDescriptor): MaybePromise<number>;
  readString(key: string | number, desc: ValueDescriptor): MaybePromise<string>;
  readBytes(key: string | number, desc: ValueDescriptor): MaybePromise<Uint8Array>;

  enterList(key: string | number, count: number): MaybePromise<number>;
  exitList(): void;

  enterStruct(key: string | number): void;
  exitStruct(): void;
}

export interface WalkerHost {
  emitNull(key: string | number, desc: ValueDescriptor): void;
  emitBool(key: string | number, value: boolean, desc: ValueDescriptor): void;
  emitNumber(key: string | number, value: number, desc: ValueDescriptor): void;
  emitString(key: string | number, value: string, desc: ValueDescriptor): void;
  emitBytes(key: string | number, value: Uint8Array, desc: ValueDescriptor): void;

  enterList(key: string | number, count: number): boolean; // Return false to skip this branch
  exitList(): void;

  enterStruct(key: string | number): boolean; // Return false to skip this branch
  exitStruct(): void;
}
