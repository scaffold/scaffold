import { BlockMeta } from '~/sbl/BlockMeta.ts';
import { Block, BlockSet, BlockSetTreeNode } from '~/sbl/messages.ts';
import { Node } from '~/sbl/NodeService.ts';
import Hash from '~/sbl/util/Hash.ts';
import { BlockSetMeta } from '~/sbl/BlockSetService.ts';

export const enum FactType {
  // Raw,
  Info,
  Block,
  BlockSet, // TODO: Rename to bag or something
  BlockSetTreeNode,
  EpochInclusionProof,
  BridgeStart,
  BridgeEnd,
}

export const enum FactSource {
  Bootstrap,
  Local,
  Remote,
}

export type FactBase = {
  hash: Hash;

  data: Uint8Array;
  type: FactType;
  message: Uint8Array;
  signature: Uint8Array;

  source: FactSource;
  fromNodes: Node[];
  toNodes: Node[];

  backtrace?: string;
};

export type InfoFact = FactBase & { type: FactType.Info };
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

export type Fact = InfoFact | BlockFact | BlockSetFact | BlockSetTreeNodeFact;
