import {
  Block,
  CollateralContractParams,
  EpochInclusionProof,
  Verifier,
} from './messages.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { Node } from './NodeService.ts';
import { BlockFact, BlockSetFact } from '~/sbl/FactMeta.ts';

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

export interface BlockCollateralization {
  block: BlockFact;
  params: CollateralContractParams;
  amountDelta: bigint;
  outputIdx: number;
}

export interface BlockMeta {
  verifiers: Verifier[];

  // TODO: Store epoch idx and/or canonicality?
  isEpoch: boolean;

  receivedTimestamp: number;
  flags: BlockFlag;
  // derivedWork: bigint;
  derivedWork: number;
  mergeableProbability: number;
  outputClaims: BlockFact[][];

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
  // collateralChain: BlockFact[];
  // postedCollateral: BlockFact[];
  passedVerification?: boolean;

  // Map from an epoch hash to the best proof from it
  epochInclusionProofs: Map<HashPrimitive, EpochInclusionProof>;

  parentBlockSets: BlockSetFact[];
  myParentBlockSet?: BlockSetFact;
  highestParentChain: BlockSetFact[];
}
