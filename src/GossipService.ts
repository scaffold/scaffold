import { Hash } from './util/Hash.ts';
import { Block, BlockStore } from './Block.ts';
import { GossipModule, GossipConfig, GossipProvider } from './GossipModule.ts';
import { TrustService } from './TrustService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class GossipProviderAdapter implements GossipProvider {
  constructor(
    private readonly store: BlockStore,
    private readonly trust: TrustService,
  ) {}

  getBlockSize(hash: Hash): number {
    const block = this.store.get(hash);
    return block ? block.size : 0;
  }

  getBlockWeightSum(hash: Hash): number {
    const block = this.store.get(hash);
    if (!block) return 0;
    return block.weightVector.reduce((s, w) => s + w, 0);
  }

  getClaimedOrigins(blockHash: Hash): Hash[] {
    const block = this.store.get(blockHash);
    if (!block) return [];
    // If block has claims, the origin is the anchor
    if (block.claims.length > 0 && block.anchor) {
      return [block.anchor];
    }
    return [];
  }

  getCollateralTarget(blockHash: Hash): Hash | undefined {
    const block = this.store.get(blockHash);
    return block?.collateralTarget;
  }

  getAggregatedBlocks(blockHash: Hash): Hash[] {
    const block = this.store.get(blockHash);
    return block ? block.aggregates : [];
  }

  getPaymentTarget(blockHash: Hash): string | undefined {
    const block = this.store.get(blockHash);
    return block?.paymentTarget;
  }

  getForStake(target: Hash): number {
    const state = this.trust.getTrustState(target);
    return state.forAmount;
  }

  getAgainstStake(target: Hash): number {
    const state = this.trust.getTrustState(target);
    return state.againstAmount;
  }
}

/** GossipModule wired to BlockStore and TrustService via ProtocolContext. */
export class GossipService extends GossipModule {
  constructor(ctx: ProtocolContext, config?: Partial<GossipConfig>) {
    const store = ctx.get(BlockStore);
    const trust = ctx.get(TrustService);
    super(new GossipProviderAdapter(store, trust), config);
  }
}
