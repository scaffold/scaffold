import { Context } from '../Context.ts';
import { Reader } from '../interfaces/Reader.ts';
import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { Block, DraftPayload, Predicate } from './types.ts';

export enum ValueType {
  Null = 0,
  Bool = 1,
  Number = 2,
  String = 3,
  Array = 4,
  Object = 5,
  // Added for the query-Reader build bridge: a Reader can hold a raw byte value
  // with no String/Object analog. Appended (not renumbered) to keep the
  // existing wire values stable. NOTE: the Zig `json-wb` ValueType constants
  // (src/contracts/json-wb/src/main.zig) must add the matching `Bytes = 6`.
  Bytes = 6,
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

export interface WalkerHost {
  emitBytes(key: string, value: Uint8Array, desc: ValueDescriptor): void;
  emitString(key: string, value: string, desc: ValueDescriptor): void;
  emitNumber(key: string, value: number, desc: ValueDescriptor): void;
  emitBool(key: string, value: boolean, desc: ValueDescriptor): void;
  emitMapStart(key: string): boolean; // Return false to skip this branch
  emitMapEnd(): void;
  emitListStart(key: string, count: number): boolean; // Return false to skip this branch
  emitListEnd(): void;
}

export interface ContractProvider {
  generate(
    predicate: Predicate,
    update: (draftPayload: DraftPayload) => void,
    signal: AbortSignal,
  ): MaybePromise<void>;

  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): MaybePromise<void>;

  walkParams?(
    contract: Hash,
    params: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void>;

  walkData?(
    contract: Hash,
    data: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void>;

  buildParams?(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array>;

  buildData?(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array>;
}

export interface ContractPlugin {
  new (ctx: Context): ContractProvider;
}
