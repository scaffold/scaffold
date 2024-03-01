import { BlockMeta } from './BlockMeta.ts';
import {
  Block,
  BlockSet,
  BlockSetTreeNode,
  ConnectionSignal,
  Identification,
  InfoRequest,
  PeerInfo,
  SignalPayload,
} from './messages.ts';
import { Connection } from './ConnectionService.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { CollateralContractDetail } from './collateralMessages.ts';
import { DetailVote } from './CollateralUtil.ts';

// TODO: Rename to packet?

export enum FactType {
  Null = 0, // Reserved
  Identification,
  PeerInfo,
  InfoRequest,
  ConnectionSignal,
  // SignalPayload,
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

export interface FactBase {
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
  signer?: Uint8Array;
  fromConnections: Connection[];

  // Publication properties
  publishAt?: number;
  toConnections: Connection[];

  // Validity properties
  collateralizations: Collateralization[];
  validities: Map<HashPrimitive, DetailVote>;

  // GC properties
  visitedAt: number;
  visitedBy?: string;
  references: number;

  // Debug properties
  factIdx: number;
  typeStr: string;
  sourceStr: string;
  sillyName: string;
  backtrace?: string;
}

export interface IdentificationFact extends FactBase, Identification {
  type: FactType.Identification;
}
export interface PeerInfoFact extends FactBase, PeerInfo {
  type: FactType.PeerInfo;
}
export interface InfoRequestFact extends FactBase, InfoRequest {
  type: FactType.InfoRequest;
}
export interface ConnectionSignalFact extends FactBase, ConnectionSignal {
  type: FactType.ConnectionSignal;
}
export interface BlockFact extends FactBase, Block, BlockMeta {
  type: FactType.Block;
}
export interface InvalidFact extends FactBase {
  type: FactType.Invalid;
}

export type Fact =
  | IdentificationFact
  | PeerInfoFact
  | InfoRequestFact
  | ConnectionSignalFact
  | BlockFact
  | InvalidFact;
// | FrontierFact;
