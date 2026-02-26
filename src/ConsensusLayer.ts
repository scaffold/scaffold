import { Hash } from './util/Hash.ts';

interface ConsensusProvider<BlockType> {
  getBlock(hash: Hash): BlockType | undefined;

  getHead(block: BlockType): Hash | undefined;
  getTails(block: BlockType): Hash[] | undefined;
  getChildren(block: BlockType): Hash[] | undefined;
  getParents(block: BlockType): Hash[] | undefined;
}

class ConsensusLayer<BlockType> {
  constructor(private provider: ConsensusProvider<BlockType>) {}

  addConflict(blockA: BlockType, blockB: BlockType) {}
  removeConflict(blockA: BlockType, blockB: BlockType) {}

  setSampledWeight(block: BlockType, key: string, weight: number) {}
}
