import {
  EpochInclusionProof,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { Node } from './NodeService.ts';
import { BlockFact, BlockSetFact } from '~/sbl/FactMeta.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';

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
  verifiers: Verifier[];

  // TODO: Store epoch idx and/or canonicality?
  isEpoch: boolean;

  receivedTimestamp: number;
  flags: BlockFlag;
  claimedWork?: bigint;
  votes: bigint;
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

  // collateralChain: BlockFact[];
  // postedCollateral: BlockFact[];
  validatedInputs: bigint; // All inputs claims that have called validate() (which covers ALL hints)
  invalidatedInputs: bigint; // All inputs claims that have called invalidate() (which covers ALL hints)
  // verificationResult?: CollateralContractDetail['claim'];

  // Map from an epoch hash to the best proof from it
  epochInclusionProofs: Map<HashPrimitive, EpochInclusionProof>;

  parentBlockSets: BlockSetFact[];
  myParentBlockSet?: BlockSetFact;
  highestParentChain: BlockSetFact[];

  frontierOutputIdx: number;
  frontierParams: FrontierTreeParams;
  frontierDetail: FrontierTreeDetail;
}
