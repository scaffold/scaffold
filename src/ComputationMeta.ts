import { WorkerDriver } from './WorkerDriverService.ts';
import { BlockInput, BlockOutput } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { InputSpec, OutputSpec } from './BlockBuilder.ts';
import { Verifier } from './messages.ts';
import { TreeObj } from './BytesTreeHelper.ts';
import { MutableTreeNode, TreeNode } from './BytesTreeOverlay.ts';

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

  contractHash: Hash;
  params: TreeNode;

  // If a contract writes a body, then at the end, the body is compared to the block body
  body: MutableTreeNode;

  // TODO: Implement this
  // It locks the parent and squashes, and returns a hash including both of them
  // getAncestorHash(): Hash;
  // getAuthorHash(): Hash;

  getHint(idx: number, bop: BurdenOfProof): TreeNode; // Only valid if this is a contract
  requireOutput(output: OutputSpec): void; // Same kind of thing as requireBody. Note that order matters here; the generator and contract must require outputs in the same order.
  requireTimestampGte(timestamp: bigint): MaybePromise<void>;
  isSignedBy(publicKey: Uint8Array): boolean;
  requireSignature(publicKey: Uint8Array): void;
  emitCorrect(): boolean; // Whether to emit a correct answer or not; returns true if contract

  fetch(contractHash: Hash, params: TreeObj): TreeNode;

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
