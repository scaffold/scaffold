// Protocol spec: docs/protocol/output-data.md

import type { ContractEnv } from '../core/ContractEnv.ts';
import type { MaybePromise } from '../util/MaybePromise.ts';
import type { Hash } from '../util/Hash.ts';
import { Reader } from '../contract/Reader.ts';

// -- Value Descriptors ------------------------------------------------

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

// -- Walker Host ------------------------------------------------------

/**
 * Host interface for the walker (reading direction).
 * The contract calls these to emit a tree of typed, annotated values.
 */
export interface WalkerHost {
  emitBytes(key: string, value: Uint8Array, desc: ValueDescriptor): void;
  emitString(key: string, value: string, desc: ValueDescriptor): void;
  emitNumber(key: string, value: number, desc: ValueDescriptor): void;
  emitBool(key: string, value: boolean, desc: ValueDescriptor): void;
  /** Begin a map/object. Returns false to skip this branch. */
  emitMapStart(key: string): boolean;
  emitMapEnd(): void;
  /** Begin a list/array. Returns false to skip this branch. */
  emitListStart(key: string, count: number): boolean;
  emitListEnd(): void;
}

// -- Builder Host -----------------------------------------------------

/**
 * The runtime type of a value, so a generic builder can decide how to serialize
 * it. Numeric values match the `request_value_type` wire return in wasm-abi.md.
 */
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

// -- Contract ---------------------------------------------------------

/**
 * A contract is a WASM module (or TypeScript equivalent) that exports
 * named functions. `run` is the verification/generation entry point
 * (required). Walker/builder methods are optional and enable generic
 * tooling (block explorers, block creation UIs).
 *
 * This mirrors the WASM export surface: each method corresponds to
 * a named WASM export.
 */
export interface Contract {
  /** Verify or generate a block (the spending condition). Required. */
  run(env: ContractEnv): MaybePromise<void>;

  /**
   * The set of output contract-hashes this contract may produce.
   *
   * On a block, outputs partition by `verifier.contract`. For every owned
   * namespace H (some claim's contract declares H here), the block's outputs
   * under H must equal exactly what the owning contract emitted, matched
   * positionally. Two claims whose contracts' namespaces overlap cannot
   * share a block. See docs/protocol/computation.md#output-namespaces.
   *
   * Undeclared / empty means the contract produces no outputs (e.g., pure
   * gate contracts like signature/timelock). Undefined is treated as [].
   */
  outputNamespaces?: Hash[];

  /** Walk verifier params bytes for display in generic tools. */
  walkParams?(params: Uint8Array, host: WalkerHost): MaybePromise<void>;

  /** Walk output data bytes for display in generic tools. */
  walkData?(data: Uint8Array, host: WalkerHost): MaybePromise<void>;

  /** Build verifier params bytes from user input. */
  buildParams?(reader: (descriptor: string) => MaybePromise<Reader>): MaybePromise<Uint8Array>;

  /** Build output data bytes from user input. */
  buildData?(reader: (descriptor: string) => MaybePromise<Reader>): MaybePromise<Uint8Array>;
}
