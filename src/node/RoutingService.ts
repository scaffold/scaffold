import { Hash } from '../util/Hash.ts';
import { BlockStore } from '../core/Block.ts';
import { GossipModule, VerifierKey } from './GossipModule.ts';
import {
  BlockAwareness,
  PushAction,
  RoutingConfig,
  RoutingModule,
  RoutingProvider,
} from './RoutingModule.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { ScopedLogger } from '../core/EventLog.ts';

class RoutingProviderAdapter implements RoutingProvider {
  constructor(private readonly store: BlockStore) {}

  getBlockSize(hash: Hash): number {
    const block = this.store.get(hash);
    if (!block) return 0;
    let size = 32 + 32; // hash + anchor
    size += block.aggregates.length * 32;
    size += block.claims.length * 4;
    for (const out of block.outputs) {
      size += 32 + out.verifier.params.length + 8 + (out.data?.length ?? 0);
    }
    return size;
  }
}

/** RoutingModule wired to BlockStore via ProtocolContext. */
export class RoutingService extends RoutingModule {
  private readonly _log?: ScopedLogger;

  constructor(
    ctx: ProtocolContext,
    gossip: GossipModule,
    config?: Partial<RoutingConfig>,
  ) {
    const store = ctx.get(BlockStore);
    super(new RoutingProviderAdapter(store), gossip, config);
    this._log = ctx.logger('routing');
  }

  override addPeer(
    peerId: string,
    pubkey: string,
    awareness: BlockAwareness,
  ): void {
    super.addPeer(peerId, pubkey, awareness);
    this._log?.info('peerAdded', { peerId });
  }

  override removePeer(peerId: string): void {
    super.removePeer(peerId);
    this._log?.info('peerRemoved', { peerId });
  }

  override reportPush(
    hash: Hash,
    peer: string,
    verifier?: VerifierKey,
  ): void {
    super.reportPush(hash, peer, verifier);
    this._log?.debug('blockPushed', {
      hash: hash.toHex(),
      toPeer: peer,
      verifier,
    });
  }

  override reportDelivery(
    hash: Hash,
    toPeer: string,
    wasNovel: boolean,
  ): void {
    super.reportDelivery(hash, toPeer, wasNovel);
    this._log?.debug('deliveryConfirmed', {
      hash: hash.toHex(),
      toPeer,
      wasNovel,
    });
  }
}
