import { Block } from './messages.ts';

enum BlockFlag {
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
  // block: Block;
  receivedTimestamp: number;
  flags: BlockFlag;
  // derivedWork: bigint;
  derivedWork: number;
  mergeableProbability: number;
  outputClaims: BlockExt[][];
}

export type BlockExt = Block & BlockMeta;
