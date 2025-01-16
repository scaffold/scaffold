import { WorkerDriver } from './WorkerDriverService.ts';
import { BlockInput, BlockOutput } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { InputSpec, OutputSpec } from './BlockBuilder.ts';
import { Verifier } from './messages.ts';

// TODO: ComputationProvider?

export const enum ComputationType {
  Contract,
  Generator,
}

// https://docs.google.com/spreadsheets/d/1y3f2oqYwDaLRqoLnz4Jr1Ws7oO_muBPrv4ro9DQaIYw/edit
export const enum BurdenOfProof {
  Invalidation, // Used for most things; one hint proving invalidation makes the contract invalid. Self-votes are VALID, and a single INVALID child vote invalidates.
  Validation, // Used for things like hash inversions; one hint proving validation makes the hash valid. Self-votes are INVALID, and a single VALID child vote validates.
}

export interface InputSource {
  input: InputSpec;
  output: BlockOutput;
  body: Uint8Array;
  timestamp: bigint;
}

export interface ComputationDriver extends WorkerDriver {
  type: ComputationType;

  getVerifier(): Verifier; // TODO: Standardize on either getVerifier() or getContractHash() and getParams()
  getContractHash(): Hash;
  getParams(): Uint8Array;

  getHint(idx: number, bop: BurdenOfProof): Uint8Array; // Only valid if this is a contract
  getBody(): Uint8Array; // Only valid if this is a contract
  requireBody(data: Uint8Array): void; // Provide body if generator, require body equals if contract. Fast-path valid if pointer equals getBody().
  requireOutput(output: OutputSpec): void; // Same kind of thing as requireBody. Note that order matters here; the generator and contract must require outputs in the same order.
  requireTimestampGte(timestamp: bigint): MaybePromise<void>;
  isSignedBy(publicKey: Uint8Array): boolean;
  requireSignature(publicKey: Uint8Array): void;
  emitCorrect(): boolean; // Whether to emit a correct answer or not; returns true if contract

  notify(verifier: Verifier): void;
  fetch(verifier: Verifier): Promise<Uint8Array>;

  collectInputs(): MaybePromise<InputSource[]>; // Returns the number of inputs matching this contractHash & params. When this is called, the value is fixed, and the return values from getInputSource() should be fixed.
  requireInput(satisfies?: Verifier, outputsTo?: Verifier): MaybePromise<InputSource>; // Adds an input if generator, returns it if contract. If getInputCount() hasn't been called, block until we have another input.
  // TODO: Maybe make multiple getters for each property so we don't have to re-generate if, for example, only the block hash changes.

  // TODO: Implement this to allow contracts to provide plaintext data that might be requested as a hint or hash inversion in the future?
  // register(data: Uint8Array): void;

  // TODO: Remove this and call requireOutput({ contractHash: frontierHash, ... }) instead?
  // requireFrontierLevel(level: number): void;

  compareBlockOrder(hashA: Hash, hashB: Hash): number; // Clamps the frontier vote

  // validate(): never;
  // invalidate(): never;
  // setValid(valid: boolean): never;

  // setBurdenOfProof(on: BurdenOfProof): void; // You can't call this after getting the hint, because we want it to be the same for ALL hints for any given verifier.
  pass(): never;
  fail(msg?: string): never;

  offsetCanonicality(offset: bigint): void;

  ingenerable(msg?: string): void; // TODO: Maybe just throw an exception instead?
}

// A contract CANNOT require inputting a specific block hash. It can request the block data, but this won't make it dependent on that block.
// Note that a contract/generator can only read input IO addressed to its contractHash & params.
