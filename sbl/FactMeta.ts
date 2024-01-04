import { BlockMeta } from '~/sbl/BlockMeta.ts';
import {
  Block,
  BlockSet,
  BlockSetTreeNode,
  ConnectionSignal,
  InfoRequest,
  NodeInfo,
} from '~/sbl/messages.ts';
import { Node } from '~/sbl/NodeService.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { BlockSetMeta } from '~/sbl/BlockSetService.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';
import { DetailVote } from '~/sbl/CollateralUtil.ts';

export enum FactType {
  Null = 0, // Reserved
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
}

export enum FactSource {
  Genesis,
  Bootstrap,
  // Building,
  Local,
  Remote,
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
  isSignedByMe: boolean;
  fromNodes: Node[];
  toNodes: Node[];

  publishAt?: number;

  collateralizations: Collateralization[];
  validities: Map<HashPrimitive, DetailVote>;

  backtrace?: string;
};

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
  & ConnectionSignal;
export type BlockFact =
  & FactBase
  & { type: FactType.Block }
  & Block
  & BlockMeta;
export type BlockSetFact =
  & FactBase
  & { type: FactType.BlockSet }
  & BlockSet
  & BlockSetMeta;
export type BlockSetTreeNodeFact =
  & FactBase
  & { type: FactType.BlockSetTreeNode }
  & BlockSetTreeNode['node'];
export type InvalidFact =
  & FactBase
  & { type: FactType.Invalid };
// export type FrontierFact =
//   & FactBase
//   & { type: FactType.Frontier }
//   & FrontierMessage
//   & FrontierMeta;

export type Fact =
  | NodeInfoFact
  | InfoRequestFact
  | ConnectionSignalFact
  | BlockFact
  | BlockSetFact
  | BlockSetTreeNodeFact
  | InvalidFact;
// | FrontierFact;
