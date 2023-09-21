import { BlockMeta } from '~/sbl/BlockMeta.ts';
import {
  Block,
  BlockSet,
  BlockSetTreeNode,
  InfoMessage,
} from '~/sbl/messages.ts';
import { Node } from '~/sbl/NodeService.ts';
import Hash from '~/sbl/util/Hash.ts';
import { BlockSetMeta } from '~/sbl/BlockSetService.ts';
import { CollateralContractDetail } from '~/sbl/collateralMessages.ts';

export enum FactType {
  Null = 0, // Reserved
  Info,
  Block,
  BlockSet, // TODO: Rename to bag or something
  BlockSetTreeNode,
  Invalid,
  // Frontier,
  // EpochInclusionProof,
  // BridgeStart,
  // BridgeEnd,
}

export enum FactSource {
  Genesis,
  Bootstrap,
  Local,
  Remote,
}

export interface Collateralization {
  block: BlockFact;
  outputIdx: number;
  detail: CollateralContractDetail;
  valid: boolean;
  amount: bigint;
}

export type FactBase = {
  hash: Hash;

  data: Uint8Array;
  type: FactType;
  message: Uint8Array;
  signature?: Uint8Array;

  source: FactSource;
  fromNodes: Node[];
  toNodes: Node[];

  publishAt?: number;

  collateralizations: Collateralization[];

  backtrace?: string;
};

export type InfoFact = FactBase & { type: FactType.Info } & InfoMessage;
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
  | InfoFact
  | BlockFact
  | BlockSetFact
  | BlockSetTreeNodeFact
  | InvalidFact;
// | FrontierFact;
