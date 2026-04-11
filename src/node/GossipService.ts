import { Hash } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import {
  BlockStore,
  COLLATERAL_CONTRACT,
  INSURANCE_CONTRACT,
  getBlockWeightVector,
  SIGNATURE_CONTRACT,
} from '../core/Block.ts';
import { GossipConfig, GossipModule, GossipProvider, PushAction } from './GossipModule.ts';
import { TrustService } from '../core/TrustService.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { ScopedLogger } from '../core/EventLog.ts';

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
      size += 32 + out.verifier.params.length + 8 + out.data.length;
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
    // Scan outputs for collateral or insurance contract.
    // Target block hash is in verifier.params (not data).
    for (const output of block.outputs) {
      if (
        Hash.equals(output.verifier.contract, COLLATERAL_CONTRACT) ||
        Hash.equals(output.verifier.contract, INSURANCE_CONTRACT)
      ) {
        if (output.verifier.params.length === 32) {
          return Hash.fromBytes(output.verifier.params);
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
    // Scan outputs for signature contract -- pubkey is in verifier.params
    for (const output of block.outputs) {
      if (Hash.equals(output.verifier.contract, SIGNATURE_CONTRACT)) {
        if (output.verifier.params.length > 0) {
          return bin2hex(output.verifier.params);
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
  private readonly _log?: ScopedLogger;

  constructor(ctx: ProtocolContext, config?: Partial<GossipConfig>) {
    const store = ctx.get(BlockStore);
    const trust = ctx.get(TrustService);
    super(new GossipProviderAdapter(store, trust), config);
    this._log = ctx.logger('gossip');
  }

  override blockReceived(hash: Hash, fromPeer: string | null): PushAction[] {
    const actions = super.blockReceived(hash, fromPeer);
    if (actions.length > 0) {
      this._log?.debug('pushDecisions', {
        hash: hash.toHex(),
        fromPeer,
        targets: actions.map((a) => ({
          peer: a.peer,
          priority: Math.round(a.priority * 1000) / 1000,
          immediate: a.immediate,
        })),
      });
    }
    return actions;
  }

  override addPeer(peerId: string, pubkey: string, awareness: import('./GossipModule.ts').BlockAwareness): void {
    super.addPeer(peerId, pubkey, awareness);
    this._log?.info('peerAdded', { peerId });
  }

  override removePeer(peerId: string): void {
    super.removePeer(peerId);
    this._log?.info('peerRemoved', { peerId });
  }

  override reportDelivery(hash: Hash, toPeer: string, wasNovel: boolean): void {
    super.reportDelivery(hash, toPeer, wasNovel);
    this._log?.debug('deliveryConfirmed', {
      hash: hash.toHex(),
      toPeer,
      wasNovel,
    });
  }
}
