// Service adapter for CollateralResolutionIndex. Wires the module to
// BlockStore, DraftStore, BlockVerificationService, and ConsensusService
// via ProtocolContext.

import type { Hash } from '../util/Hash.ts';
import { BlockStore, type Block } from '../core/Block.ts';
import { BlockDraft, DraftStore } from '../core/BlockDraft.ts';
import { BlockVerificationService } from '../core/BlockVerificationService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import {
  CollateralResolutionIndex,
  type CollateralResolutionIndexProvider,
  type VerificationStatus,
} from './CollateralResolutionIndex.ts';

export class CollateralResolutionIndexService extends CollateralResolutionIndex {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const draftStore = ctx.get(DraftStore);
    const blockVerification = ctx.get(BlockVerificationService);
    const consensus = ctx.get(ConsensusService);
    const log = ctx.logger('trustgate');

    const provider: CollateralResolutionIndexProvider = {
      iterateBlocks(): Iterable<Block> {
        return store.values();
      },
      iterateReadyDrafts(): Iterable<BlockDraft> {
        return draftStore.getByStatus('ready');
      },
      onBlockAdded(cb) {
        return store.onAdded(cb);
      },
      onDraftTransition(cb) {
        return draftStore.onTransition(cb);
      },
      getVerificationStatus(h: Hash): VerificationStatus {
        return blockVerification.getStatus(h);
      },
      onVerificationStatusChanged(cb) {
        return blockVerification.onStatusChanged(cb);
      },
      isCanonical(h: Hash): boolean {
        return consensus.isCanonical(h);
      },
      onCanonicalityChanged(cb) {
        return consensus.onCanonicalityChange(cb);
      },
      onMalformedVerdict(source, err) {
        log?.warn('malformedVerdict', {
          sourceKind: source.kind,
          source: source.hash.toHex(),
          error: err instanceof Error ? err.message : String(err),
        });
      },
    };

    super(provider);
  }
}
