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
  blockTimestampMs: number;
}

export interface PutOptions {
  predicate: Predicate;
  claimBlocks?: Hash[];
  result?: Uint8Array;
  outputs?: { predicate: Predicate; body: Uint8Array; amount: bigint }[];
  capabilities?: {}[];
}

export interface ContractEnv {
  mode(): ExecutionMode;

  // This is only callable while verifying
  blockHash(): Hash;

  contractHash(): Hash;
  params(truncate?: number): Uint8Array;

  // These set and return self-claimed outputs with amount === 0
  getResult(key?: Predicate): MaybePromise<Uint8Array>;
  setResult(result: Uint8Array, key?: Predicate): void;

  // The `output` predicate is the unclaimed output, defaulting to the currently executing predicate
  // The `from` predicate is a filter for blocks to claim from
  // Returned outputs always have amount > 0
  // You can use the EXACT_BLOCK_CONTRACT to only allow claims from a specific block
  // TODO: Make sure contracts have an OUTPUT_NAMESPACES property so outputs are correctly partitioned
  claimOne(from?: Predicate, output?: Predicate): MaybePromise<ClaimResult>;
  claimAll(from?: Predicate, output?: Predicate): MaybePromise<ClaimResult[]>;

  // Let's omit this for now until we find a case that getResult() doesn't handle.
  // getOutputs(predicate: Predicate): { body: Uint8Array; amount: bigint }[];

  fetch(from: Predicate, output?: Predicate): MaybePromise<Uint8Array>;

  // This requires that the predicate is claimed by the same block
  require(opts: PutOptions): void;

  // This creates a new separate block
  put(opts: PutOptions): MaybePromise<Hash>;

  // Requires amount > 0
  send(to: Predicate, amount: bigint, body?: Uint8Array): void;

  waitUntil(timestampMs: number): MaybePromise<void>;
  sign(publicKey: Uint8Array): void;

  debug(message: string, data?: Record<string, unknown>): void;
}
