// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { createDraft, Draft, DraftStore } from './Draft.ts';
import type { ClaimRef } from './Node.ts';
import { Output } from './BlockCreationModule.ts';
import { ConsensusModule } from './ConsensusModule.ts';
import { type GeneratorHandle, type GeneratorProvider } from './Generator.ts';

/**
 * Orchestrates the draft lifecycle: creation, consensus registration,
 * generator dispatch, and margin-based cancellation.
 */
export class DraftManager {
  private readonly store: DraftStore;
  private readonly consensus: ConsensusModule<unknown>;
  private readonly generator: GeneratorProvider;
  private readonly handles = new Map<HashPrimitive, GeneratorHandle>();
  private readonly _onDraftReady?: (draft: Draft) => void;

  constructor(
    store: DraftStore,
    consensus: ConsensusModule<unknown>,
    generator: GeneratorProvider,
    opts?: { onDraftReady?: (draft: Draft) => void },
  ) {
    this.store = store;
    this.consensus = consensus;
    this.generator = generator;
    this._onDraftReady = opts?.onDraftReady;
  }

  /**
   * Create a draft, register it in consensus, start the generator.
   * Returns the created draft.
   */
  createDraft(fields: {
    claims: ClaimRef[];
    outputs: Output[];
    declaredWeight: number;
    refs?: Hash[];
  }): Draft {
    const draft = createDraft(fields);
    this.store.add(draft);

    // Register in consensus as a phantom block
    this.consensus.addBlock(draft.draftId);
    this.consensus.setVerifiedWeight(draft.draftId, [draft.declaredWeight]);

    // Transition to generating before starting the generator,
    // since the generator may synchronously transition to ready/cancelled.
    this.store.transition(draft.draftId, { phase: 'generating' });

    // Start generation
    const handle = this.generator.generate(draft);
    this.handles.set(draft.draftId.toPrimitive(), handle);

    return draft;
  }

  /** Cancel a draft: stop generator, remove from consensus, remove from store. */
  /**
   * Detach a draft from the live machinery (consensus + generator
   * handle) without transitioning it to a terminal status. Used by the
   * solidification path: the draft transitions to `solidified` (with
   * the new block reference) but its consensus contribution is replaced
   * by the real block, so we drop it from the consensus side.
   */
  detachDraft(draftId: Hash): void {
    const key = draftId.toPrimitive();
    const handle = this.handles.get(key);
    if (handle) {
      handle.cancel();
      this.handles.delete(key);
    }
    this.consensus.removeBlock(draftId);
  }

  cancelDraft(draftId: Hash, reason: string = 'cancelled'): void {
    const key = draftId.toPrimitive();

    // Cancel generator handle
    const handle = this.handles.get(key);
    if (handle) {
      handle.cancel();
      this.handles.delete(key);
    }

    // Remove from consensus -- the draft no longer competes for any
    // outputs, even though the Draft record stays in DraftStore as a
    // failed-status historical entry.
    this.consensus.removeBlock(draftId);

    // Transition to failed -- the draft persists in the store with
    // its terminal status so we don't relaunch the generator and so
    // debug tools can see why this draft ended.
    const draft = this.store.get(draftId);
    if (draft && !isTerminalDraftStatus(draft.status)) {
      this.store.transition(draftId, {
        phase: 'failed',
        reason,
        at: 'cancelled',
      });
    }
  }
}

function isTerminalDraftStatus(s: { phase: string }): boolean {
  return s.phase === 'failed';
}
