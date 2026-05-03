import { Hash } from '../util/Hash.ts';
import { BlockStore } from '../core/Block.ts';
import {
  BlockOutput,
  GossipModule,
  GossipProvider,
  UnclaimedOutput,
  VerifierKey,
} from './GossipModule.ts';
import { UtxoIndex, verifierKey } from './UtxoIndex.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { ScopedLogger } from '../core/EventLog.ts';

class GossipProviderAdapter implements GossipProvider {
  constructor(
    private readonly store: BlockStore,
    private readonly utxoIndex: UtxoIndex,
  ) {}

  getBlockOutputs(hash: Hash): BlockOutput[] {
    const block = this.store.get(hash);
    if (!block) return [];

    // Determine self-claimed output indices
    const selfClaims = new Set(
      block.claimIndices.filter((c) => c < block.outputs.length),
    );

    return block.outputs
      .map((o, i) => ({
        index: i,
        verifierKey: verifierKey(o.verifier.contract, o.verifier.params),
        value: o.value,
      }))
      .filter((_, i) => !selfClaims.has(i));
  }

  getUnclaimedOutputs(vk: VerifierKey): UnclaimedOutput[] {
    return this.utxoIndex.getByVerifierKey(vk).map((entry) => ({
      blockHash: entry.blockHash,
      verifierKey: vk,
      value: entry.value,
    }));
  }
}

/** GossipModule wired to BlockStore and UtxoIndex via ProtocolContext. */
export class GossipService extends GossipModule {
  private readonly _log?: ScopedLogger;

  constructor(ctx: ProtocolContext, utxoIndex: UtxoIndex) {
    const store = ctx.get(BlockStore);
    super(new GossipProviderAdapter(store, utxoIndex));
    this._log = ctx.logger('gossip');

    // Log send actions
    this.onSendAction((action) => {
      this._log?.debug('sendAction', {
        block: action.block.toHex(),
        trigger: action.trigger.toHex(),
        verifier: action.verifier,
        amount: action.amount,
      });
    });
  }

  override notifyClaimResolved(
    claimant: Hash,
    verifier: VerifierKey,
    value: number,
    claimedBlock: Hash,
  ): void {
    super.notifyClaimResolved(claimant, verifier, value, claimedBlock);
    this._log?.debug('claimResolved', {
      claimant: claimant.toHex(),
      verifier,
      value,
      claimedBlock: claimedBlock.toHex(),
    });
  }
}
