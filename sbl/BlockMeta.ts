import {
  Block,
  EpochInclusionProof,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';

export const enum BlockFlag {
  None = 0,

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

// type BlockIO = Pick<Block, 'frontier_vote' | 'inputs' | 'outputs'>;

export interface BlockMeta {
  original: Block; // TODO: Remove

  verifiers: Verifier[];

  // selfWeightMin: bigint;
  // selfWeightMax: bigint;
  // descendantWeight: bigint;
  // claimDelta: bigint;
  // voterWeight: bigint;
  // canonicality: bigint;

  receivedTimestamp: number;
  flags: BlockFlag;
  claimedWork?: bigint;
  votes: bigint;
  // derivedWork: bigint;
  derivedWork: number;
  mergeableProbability: number;

  // Note that when using this, we also need to consider (1) currently-running generators, and (2) generated but not yet emitted BlockSpecs.
  outputClaims: { block: BlockFact; inputIdx: number }[][]; // TODO: Do we need inputIdx here?

  isCanonical: boolean;

  // Note that when using this, we also need to consider (1) currently-running generators, and (2) generated but not yet emitted BlockSpecs.
  frontierVoters: BlockFact[];

  propagationMask: number;

  derivedWorkValue: number;
  derivedWorkError: number;
  mergeableLogProbabilityValue: number;
  mergeableLogProbabilityError: number;

  // internalCanonicalityProb: number;
  // externalCanonicalityProb: number;

  canonicalityOld: number; // TODO: bigint?
  collateral: number; // TODO: bigint?

  // collateralChain: BlockFact[];
  // postedCollateral: BlockFact[];
  // validatedInputs: bigint; // All inputs claims that have called validate() (which covers ALL hints)
  // invalidatedInputs: bigint; // All inputs claims that have called invalidate() (which covers ALL hints)
  // verificationResult?: CollateralClaim;

  // Map from an epoch hash to the best proof from it
  epochInclusionProofs: Map<HashPrimitive, EpochInclusionProof>;

  frontierOutputIdx: number;
  frontierParams: FrontierTreeParams;
  frontierDetail: FrontierTreeDetail;
}
