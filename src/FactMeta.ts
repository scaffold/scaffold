import { BlockMeta } from './BlockMeta.ts';
import {
  Block,
  BlockSet,
  BlockSetTreeNode,
  ConnectionSignal,
  Identification,
  InfoRequest,
  NodeInfo,
} from './messages.ts';
import { Node } from './NodeService.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { CollateralContractDetail } from './collateralMessages.ts';
import { DetailVote } from './CollateralUtil.ts';

// TODO: Rename to packet?

export enum FactType {
  Null = 0, // Reserved
  Identification,
  NodeInfo,
  InfoRequest,
  ConnectionSignal,
  Block, // TODO: Rename to bundle or something
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
  // The hash of full data, including header, type, message, and signature.
  hash: Hash;

  // Packet parsing properties
  data: Uint8Array; // The full packet data
  type: FactType; // The type
  message: Uint8Array; // The subset of the packet data that will be deserialized into a sub-type.
  signature?: Uint8Array; // The subset of the packet data that should be used as a signature, if any.

  // Reception properties
  receivedAt: number;
  source: FactSource;
  signer: Uint8Array;
  fromNodes: Node[];

  // Publication properties
  publishAt?: number;
  toNodes: Node[];

  // Validity properties
  collateralizations: Collateralization[];
  validities: Map<HashPrimitive, DetailVote>;

  // GC properties
  visitedAt: number;
  visitedBy?: string;
  references: number;

  // Debug properties
  sillyName: string;
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
