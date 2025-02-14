import { BlockMeta } from './BlockMeta.ts';
import { Block, ConnectionSignal, PeerInfo } from './messages.ts';
import { Connection } from './Connection.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { CollateralContractDetail } from './collateralMessages.ts';
import { DetailVote } from './CollateralUtil.ts';
import { Index } from './protocol/channel.ts';
import { Logger } from './Logger.ts';

// TODO: Rename to packet?

export enum FactType {
  // Private facts can only be created locally
  Ref = -1,

  // Public facts can be created by remote data
  Block = 0, // TODO: Rename to bundle or something
  PeerInfo,
  // InfoRequest,
  ConnectionSignal,
  // SignalPayload,
  Index,
  // BlockSet, // TODO: Rename to bag or something
  // BlockSetTreeNode,
  // MerkleTreeNode,
  // Invalid,
  // Frontier,
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

export interface Reception {
  timestamp: number;
  conn: Connection;
  full: boolean;
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
  receptions: Reception[];
  fromConnections: Connection[];
  usefulness: number;

  // Publication properties
  publishAt?: number;
  toConnections: Connection[];

  requesting: Set<Connection>;

  // Validity properties
  collateralizations: Collateralization[];
  validities: Map<HashPrimitive, DetailVote>;

  // GC properties
  visitedAt: number;
  visitedBy?: string;
  references: number;

  // Random sampler properties
  // samplerState: SamplerState;

  // Logger
  log?: Logger;

  // Debug properties
  factIdx: number;
  typeStr: string;
  sourceStr: string;
  sillyName: string;
  backtrace?: string;
}

export interface FactRef extends Pick<FactBase, 'hash' | 'receptions' | 'requesting' | 'log'> {
  type: FactType.Ref;
}
export interface BlockFact extends FactBase, Block, BlockMeta {
  type: FactType.Block;
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
export interface IndexFact extends FactBase, Index {
  type: FactType.Index;
}

export type Fact =
  | BlockFact
  | PeerInfoFact
  | ConnectionSignalFact
  // | SignalPayloadFact
  | IndexFact;
