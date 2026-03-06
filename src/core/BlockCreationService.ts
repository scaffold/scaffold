import { Hash } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';
import {
  AGGREGATION_CONTRACT,
  Block,
  BlockStore,
  getBlockOutputCount,
  getBlockWeightVector,
} from './Block.ts';
import { BlockCreationModule, BlockCreationProvider } from './BlockCreationModule.ts';
import { ConflictService } from './ConflictService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class BlockCreationProviderAdapter implements BlockCreationProvider<Block> {
  constructor(
    private readonly store: BlockStore,
    private readonly conflict: ConflictService,
  ) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getHash(block: Block): Hash {
    return block.hash;
  }

  getAnchor(block: Block): Hash {
    return block.anchor;
  }

  getOutputCount(block: Block): number {
    return getBlockOutputCount(block);
  }

  getWeightVector(block: Block): number[] {
    return getBlockWeightVector(block);
  }

  getAnchorDepth(from: Hash, ancestor: Hash): number | undefined {
    return this.store.getAnchorDepth(from, ancestor);
  }

  getRebasedClaimMask(blockHash: Hash, targetAnchor: Hash): BitVector | null {
    const result = this.conflict.rebase(blockHash, targetAnchor);
    if (!result) return null;
    return result.mask;
  }

  getAggregationContract(): Hash {
    return AGGREGATION_CONTRACT;
  }
}

/** BlockCreationModule wired to BlockStore and ConflictService via ProtocolContext. */
export class BlockCreationService extends BlockCreationModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const conflict = ctx.get(ConflictService);
    super(new BlockCreationProviderAdapter(store, conflict));
  }
}
