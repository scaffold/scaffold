import { BlockMeta } from '~/sbl/BlockMeta.ts';
import {
  Block,
  BlockSet,
  BlockSetTreeNode,
  CollateralContractParams,
  InfoMessage,
} from '~/sbl/messages.ts';
import { Node } from '~/sbl/NodeService.ts';
import Hash from '~/sbl/util/Hash.ts';
import { BlockSetMeta } from '~/sbl/BlockSetService.ts';

export const enum FactType {
  Null = 0, // Reserved
  Info,
  Block,
  BlockSet, // TODO: Rename to bag or something
  BlockSetTreeNode,
  Frontier,
  EpochInclusionProof,
  BridgeStart,
  BridgeEnd,
}

export const enum FactSource {
  Genesis,
  Bootstrap,
  Local,
  Remote,
}

export interface Collateralization {
  block: BlockFact;
  params: CollateralContractParams;
  amountDelta: bigint;
  outputIdx: number;
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
// export type FrontierFact =
//   & FactBase
//   & { type: FactType.Frontier }
//   & FrontierMessage
//   & FrontierMeta;

export type Fact =
  | InfoFact
  | BlockFact
  | BlockSetFact
  | BlockSetTreeNodeFact;
// | FrontierFact;
