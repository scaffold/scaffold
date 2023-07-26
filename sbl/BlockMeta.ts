import { Block, CollateralContractParams, Verifier } from './messages.ts';
import Hash from './util/Hash.ts';

export const enum BlockFlag {
  Null = 0,

  CheckedZeroSum = 1 << 0,
  CheckedTimestamp = 1 << 1,
  CheckedMergability = 1 << 2,
  CheckedVerification = 1 << 3,

  PassedZeroSum = 1 << 8,
  PassedTimestamp = 1 << 9,
  PassedMergability = 1 << 10,
  PassedVerification = 1 << 11,

  IsPublic = 1 << 16,
}

export const enum BlockSource {
  Bootstrap,
  Local,
  Remote,
}

export interface BlockCollateralization {
  block: BlockExt;
  params: CollateralContractParams;
  amountDelta: bigint;
  outputIdx: number;
}

export interface BlockMeta {
  hash: Hash;
  nonce: number;

  source: BlockSource;

  data: Uint8Array;
  signature: Uint8Array;

  verifiers: Verifier[];

  // block: Block;
  receivedTimestamp: number;
  flags: BlockFlag;
  // derivedWork: bigint;
  derivedWork: number;
  mergeableProbability: number;
  outputClaims: BlockExt[][];

  propagationMask: number;

  derivedWorkValue: number;
  derivedWorkError: number;
  mergeableLogProbabilityValue: number;
  mergeableLogProbabilityError: number;

  // internalCanonicalityProb: number;
  // externalCanonicalityProb: number;

  canonicality: number; // TODO: bigint?
  collateral: number; // TODO: bigint?

  collateralizations: BlockCollateralization[];
  // collateralChain: BlockExt[];
  // postedCollateral: BlockExt[];
  passedVerification?: boolean;

  backtrace?: string;
}

export type BlockExt = Block & BlockMeta;
