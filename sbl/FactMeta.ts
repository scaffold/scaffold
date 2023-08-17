import { BlockMeta } from '~/sbl/BlockMeta.ts';
import { Block, BlockSet } from '~/sbl/messages.ts';
import { Node } from '~/sbl/NodeService.ts';
import Hash from '~/sbl/util/Hash.ts';
import { BlockSetMeta } from '~/sbl/BlockSetService.ts';

export const enum FactType {
  Info,
  Block,
  BlockSet, // TODO: Rename to bag or something
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

  source: FactSource;

  data: Uint8Array;
  signature: Uint8Array;

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

export type Fact = InfoFact | BlockFact | BlockSetFact;
