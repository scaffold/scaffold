import { Predicate } from '../../graph/types.ts';
import { Hash } from '../../util/Hash.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';

export enum ExecutionMode {
  Generation = 0,
  Verification = 1,
}

export interface ClaimResult {
  fromBlockHash: Hash;
  body: Uint8Array;
  amount: bigint;
}

export interface PutOptions {
  contracts: { predicate: Predicate; claimBlocks: Hash[]; result?: Uint8Array }[];
  outputs: { predicate: Predicate; body: Uint8Array; amount: bigint }[];
  capabilities: {}[];
}

export interface ContractEnv {
  mode(): ExecutionMode;

  // This is only callable while verifying
  blockHash(): Hash;

  contractHash(): Hash;
  params(): Uint8Array;

  getResult(): Uint8Array;
  setResult(result: Uint8Array): void;

  // The `output` predicate is the unclaimed output, defaulting to the currently executing predicate
  // The `from` predicate is a filter for blocks to claim from
  // You can use the EXACT_BLOCK_CONTRACT to only allow claims from a specific block
  // TODO: Make sure contracts have an OUTPUT_NAMESPACES property so outputs are correctly partitioned
  claimOne(from?: Predicate, output?: Predicate): MaybePromise<ClaimResult>;
  claimAll(from?: Predicate, output?: Predicate): MaybePromise<ClaimResult[]>;

  // Let's omit this for now until we find a case that getResult() doesn't handle.
  // getOutputs(predicate: Predicate): { body: Uint8Array; amount: bigint }[];

  fetch(from: Predicate, output?: Predicate): MaybePromise<Uint8Array>;

  put(opts: PutOptions): MaybePromise<Hash>;

  send(contract: Hash, params: Uint8Array, amount: bigint): void;
}
