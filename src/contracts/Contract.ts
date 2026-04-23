// Protocol spec: docs/protocol/output-data.md

import type { ContractEnv } from '../core/ContractEnv.ts';
import type { MaybePromise } from '../util/MaybePromise.ts';
import type { Hash } from '../util/Hash.ts';

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
 * Host interface for the builder (writing direction).
 * The contract calls these to request field values from the user.
 */
export interface BuilderHost {
  requestBytes(key: string, desc: ValueDescriptor): Uint8Array;
  requestString(key: string, desc: ValueDescriptor): string;
  requestNumber(key: string, desc: ValueDescriptor): number;
  requestBool(key: string, desc: ValueDescriptor): boolean;
  requestArrayLength(key: string, desc: ValueDescriptor): number;
  beginObject(key: string): void;
  endObject(): void;
  beginArray(key: string): void;
  endArray(): void;
  validationError(key: string, message: string): void;
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
  walkParams?(params: Uint8Array, host: WalkerHost): void;

  /** Walk output data bytes for display in generic tools. */
  walkData?(data: Uint8Array, host: WalkerHost): void;

  /** Build verifier params bytes from user input. */
  buildParams?(host: BuilderHost): Uint8Array;

  /** Build output data bytes from user input. */
  buildData?(host: BuilderHost): Uint8Array;
}
