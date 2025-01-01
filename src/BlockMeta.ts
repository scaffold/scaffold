import { EpochInclusionProof, FrontierTreeDetail, FrontierTreeParams } from './messages.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import { CollateralContractDetail } from './collateralMessages.ts';
import { BlockDraft } from './BlockBuilder.ts';

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

export interface InputDetail {
  block?: BlockFact;
  frontierVoteOutputIdx?: number;
  subtreeIdx?: number;
}

export interface OutputClaim {
  block: BlockFact;
  inputIdx: number;
}

export const ZERO_BLOCK = Symbol('ZeroBlock');

export interface BlockMeta {
  // verifiers: (Verifier | undefined)[];

  // This is the sum of the self min weight and all descendant min weights
  descWeight: bigint;
  treeParent?: BlockFact;

  // selfWeightMin: bigint;
  // selfWeightMax: bigint;
  // descendantWeight: bigint;
  // claimDelta: bigint;
  // voterWeight: bigint;
  canonicality: bigint;

  flags: BlockFlag;
  claimedWork?: bigint;
  votes: bigint;
  // derivedWork: bigint;
  derivedWork: number;
  mergeableProbability: number;

  // TODO: Remove; unused
  // For each input, the index of the referenced output in the frontier vote output space.
  // If it comes from a subtree, the number will be negative. It will be the bitwise complement of the subtree index.
  // Undefined if unknown
  inputOutputIdxs: (number | undefined)[];

  // Note that when using this, we also need to consider (1) currently-running generators, and (2) generated but not yet emitted BlockSpecs.
  outputClaims: OutputClaim[][];

  isCanonical: boolean;

  frontierVoteBlock?: BlockFact | typeof ZERO_BLOCK;
  frontierChainDepth?: number;

  // Note that when using this, we also need to consider (1) currently-running generators, and (2) generated but not yet emitted BlockSpecs.
  frontierVoters: BlockFact[];

  utxoCount?: number; // Pre-inputs

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

  // Only republish a draft if the canonicality of the new block will be higher.
  // If, for example, we're just building on an uncanonical input, there's nothing we can do but ignore the source until/unless that changes.
  // Or, for example, we're double-claiming an output whose other claim is very well established.
  persistentSources: BlockDraft[];

  // updateCbs: (() => void)[];
}
