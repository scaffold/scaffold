import { Hash } from './util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { TrustModule, TrustProvider } from './TrustModule.ts';
import { ConsensusService } from './ConsensusService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class TrustProviderAdapter implements TrustProvider<Block> {
  constructor(
    private readonly store: BlockStore,
    private readonly consensus: ConsensusService,
  ) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getAnchor(block: Block): Hash {
    return block.anchor;
  }

  getDeclaredWeight(block: Block): number {
    return block.declaredWeight;
  }

  getChildDeclaredWeight(block: Block, childIndex: number): number {
    return block.childDeclaredWeights[childIndex] ?? 0;
  }

  isAggregated(hash: Hash): boolean {
    return this.store.isAggregated(hash);
  }

  isCanonical(hash: Hash): boolean {
    return this.consensus.isCanonical(hash);
  }

  isAncestor(ancestor: Hash, descendant: Hash): boolean {
    return this.store.isAncestor(ancestor, descendant);
  }
}

/** TrustModule wired to BlockStore and ConsensusService via ProtocolContext. */
export class TrustService extends TrustModule<Block> {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const consensus = ctx.get(ConsensusService);
    super(new TrustProviderAdapter(store, consensus));
  }
}
