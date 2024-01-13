import { BlockMeta } from '~/sbl/BlockMeta.ts';
import {
  Block,
  BlockSet,
  BlockSetTreeNode,
  ConnectionSignal,
  Identification,
  InfoRequest,
  NodeInfo,
} from '~/sbl/messages.ts';
import { Node } from '~/sbl/NodeService.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { DetailVote } from '~/sbl/CollateralUtil.ts';

export enum FactType {
  Null = 0, // Reserved
  Identification,
  NodeInfo,
  InfoRequest,
  ConnectionSignal,
  Block,
  BlockSet, // TODO: Rename to bag or something
  BlockSetTreeNode,
  MerkleTreeNode,
  Invalid,
  // Frontier,
  // EpochInclusionProof,
  // BridgeStart,
  // BridgeEnd,
  _SIZE,
}

export enum FactSource {
  Genesis,
  Bootstrap,
  // Building,
  Local,
  Remote,
  Storage,
}

export interface Collateralization {
  collateralBlock: BlockFact;
  collateralOutputIdx: number;
  detail: CollateralContractDetail;
  amount: bigint;
}

export type FactBase = {
  hash: Hash;

  sillyName: string;

  data: Uint8Array;
  type: FactType;
  message: Uint8Array;
  signature?: Uint8Array;

  source: FactSource;
  signer: Uint8Array;
  fromNodes: Node[];
  toNodes: Node[];

  publishAt?: number;

  collateralizations: Collateralization[];
  validities: Map<HashPrimitive, DetailVote>;

  backtrace?: string;
};

export type IdentificationFact =
  & FactBase
  & { type: FactType.Identification }
  & Identification;
export type NodeInfoFact =
  & FactBase
  & { type: FactType.NodeInfo }
  & NodeInfo;
export type InfoRequestFact =
  & FactBase
  & { type: FactType.InfoRequest }
  & InfoRequest;
export type ConnectionSignalFact =
  & FactBase
  & { type: FactType.ConnectionSignal }
  & ConnectionSignal
  & { isSelfInitiator: boolean };
export type BlockFact =
  & FactBase
  & { type: FactType.Block }
  & Block
  & BlockMeta;
export type InvalidFact =
  & FactBase
  & { type: FactType.Invalid };
// export type FrontierFact =
//   & FactBase
//   & { type: FactType.Frontier }
//   & FrontierMessage
//   & FrontierMeta;

export type Fact =
  | IdentificationFact
  | NodeInfoFact
  | InfoRequestFact
  | ConnectionSignalFact
  | BlockFact
  | InvalidFact;
// | FrontierFact;
