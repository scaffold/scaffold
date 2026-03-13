import { Hash } from '../util/Hash.ts';
import {
  Block,
  BlockStore,
  COLLATERAL_CONTRACT,
  getBlockWeightVector,
  SIGNATURE_CONTRACT,
} from './Block.ts';
import { GossipConfig, GossipModule, GossipProvider } from './GossipModule.ts';
import { TrustService } from './TrustService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class GossipProviderAdapter implements GossipProvider {
  constructor(
    private readonly store: BlockStore,
    private readonly trust: TrustService,
  ) {}

  getBlockSize(hash: Hash): number {
    const block = this.store.get(hash);
    if (!block) return 0;
    // Compute size from serialization: rough estimate
    let size = 32 + 32; // hash + anchor
    size += block.aggregates.length * 32;
    size += block.claims.length * 4;
    for (const out of block.outputs) {
      size += 32 + out.verifier.params.length + 8 + out.detail.length;
    }
    return size;
  }

  getBlockWeightSum(hash: Hash): number {
    const block = this.store.get(hash);
    if (!block) return 0;
    return getBlockWeightVector(block).reduce((s, w) => s + w, 0);
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
    if (!block) return undefined;
    // Scan outputs for collateral contract
    for (const output of block.outputs) {
      if (Hash.equals(output.verifier.contract, COLLATERAL_CONTRACT)) {
        try {
          const data = JSON.parse(new TextDecoder().decode(output.detail));
          return Hash.fromHex(data.target);
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }

  getAggregatedBlocks(blockHash: Hash): Hash[] {
    const block = this.store.get(blockHash);
    return block ? block.aggregates : [];
  }

  getPaymentTarget(blockHash: Hash): string | undefined {
    const block = this.store.get(blockHash);
    if (!block) return undefined;
    // Scan outputs for signature contract
    for (const output of block.outputs) {
      if (Hash.equals(output.verifier.contract, SIGNATURE_CONTRACT)) {
        try {
          const data = JSON.parse(new TextDecoder().decode(output.detail));
          return data.publicKey;
        } catch {
          continue;
        }
      }
    }
    return undefined;
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
