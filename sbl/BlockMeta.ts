import { Block } from './messages.ts';
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

export interface BlockMeta {
  hash: Hash;
  nonce: number;

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

  canonicality: number; // TODO: bigint?
  collateral: number; // TODO: bigint?

  passedVerification?: boolean;
}

export type BlockExt = Block & BlockMeta;
