import { FrontierTreeDetail, FrontierTreeParams } from './messages.ts';
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

// TODO: Make ZERO_BLOCK be a mock block with properties
interface ZeroBlock {
  frontierChainRoot: ZeroBlock;
  frontierChainDepth: 0;
}
export const ZERO_BLOCK = Symbol('ZeroBlock');

export interface BlockMeta {
  // verifiers: (Verifier | undefined)[];

  weight: bigint;

  newOutputSpends: Map<number, BlockFact[]>;

  // Note this will include squashers and squashes since they will likely spend the same utxos
  conflicts: Set<BlockFact>;

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
  // TODO: Remove; sometimes an output will be claimed by a tree but we don't know the exact block yet.
  outputClaims: OutputClaim[][];

  isCanonical: boolean;

  parentBlock?: BlockFact | typeof ZERO_BLOCK;

  parentChainRoot: BlockFact | typeof ZERO_BLOCK;
  parentChainDepth: number;

  // Note that when using this, we also need to consider (1) currently-running generators, and (2) generated but not yet emitted BlockSpecs.
  children: BlockFact[];

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

  // TODO: Remove
  // frontierVote: Hash;
  // frontierOutputIdx: number;
  // frontierParams: FrontierTreeParams;
  // frontierDetail: FrontierTreeDetail;

  squashers: BlockFact[];

  // Only republish a draft if the canonicality of the new block will be higher.
  // If, for example, we're just building on an uncanonical input, there's nothing we can do but ignore the source until/unless that changes.
  // Or, for example, we're double-claiming an output whose other claim is very well established.
  persistentSources: BlockDraft[];

  // updateCbs: (() => void)[];
}
