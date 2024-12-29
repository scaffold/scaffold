import { BlockMeta } from './BlockMeta.ts';
import { Block, ConnectionSignal, Identification, PeerInfo, SignalPayload } from './messages.ts';
import { Connection } from './ConnectionService.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { CollateralContractDetail } from './collateralMessages.ts';
import { DetailVote } from './CollateralUtil.ts';

// TODO: Rename to packet?

export enum FactType {
  Null = 0, // Reserved
  Identification,
  PeerInfo,
  // InfoRequest,
  ConnectionSignal,
  // SignalPayload,
  Block, // TODO: Rename to bundle or something
  // BlockSet, // TODO: Rename to bag or something
  // BlockSetTreeNode,
  // MerkleTreeNode,
  // Invalid,
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
  // type: FactType; // The type
  message: Uint8Array; // The subset of the packet data that will be deserialized into a sub-type.

  // Signature properties
  signature?: Uint8Array; // The subset of the packet data that should be used as a signature
  signer?: Uint8Array; // The recovered public key of the signature

  // Reception properties
  receivedAt: number;
  source: FactSource;
  fromConnections: Connection[];
  usefulness: number;

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

  // Random sampler properties
  // samplerState: SamplerState;

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
export interface ConnectionSignalFact extends FactBase, ConnectionSignal {
  type: FactType.ConnectionSignal;
}
// export interface SignalPayloadFact extends FactBase, SignalPayload {
//   type: FactType.SignalPayload;
// }
export interface BlockFact extends FactBase, Block, BlockMeta {
  type: FactType.Block;
}

export type Fact =
  | IdentificationFact
  | PeerInfoFact
  | ConnectionSignalFact
  // | SignalPayloadFact
  | BlockFact;
