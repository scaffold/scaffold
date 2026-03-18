// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { BlockDraft, createDraft, DraftStore, ResolvedClaim } from './BlockDraft.ts';
import { Output } from './BlockCreationModule.ts';
import { ConsensusModule } from './ConsensusModule.ts';
import { GeneratorHandle, GeneratorProvider } from './Generator.ts';

/**
 * Orchestrates the draft lifecycle: creation, consensus registration,
 * generator dispatch, and margin-based cancellation.
 */
export class DraftManager {
  private readonly store: DraftStore;
  private readonly consensus: ConsensusModule<unknown>;
  private readonly generator: GeneratorProvider;
  private readonly handles = new Map<HashPrimitive, GeneratorHandle>();

  constructor(
    store: DraftStore,
    consensus: ConsensusModule<unknown>,
    generator: GeneratorProvider,
  ) {
    this.store = store;
    this.consensus = consensus;
    this.generator = generator;
  }

  /**
   * Create a draft, register it in consensus, start the generator.
   * Returns the created draft.
   */
  createDraft(fields: {
    resolvedClaims: ResolvedClaim[];
    outputs: Output[];
    declaredWeight: number;
    anchor: Hash;
    refs?: Hash[];
    aggregates?: Hash[];
    includeConstraints?: Hash[];
  }): BlockDraft {
    const draft = createDraft(fields);
    this.store.add(draft);

    // Register in consensus as a phantom block
    this.consensus.addBlock(draft.draftId);
    this.consensus.setVerifiedWeight(draft.draftId, [draft.declaredWeight]);

    // Start generation
    const handle = this.generator.generate(draft);
    this.handles.set(draft.draftId.toPrimitive(), handle);

    // Transition to generating
    this.store.transition(draft.draftId, 'generating');

    return draft;
  }

  /** Cancel a draft: stop generator, remove from consensus, remove from store. */
  cancelDraft(draftId: Hash): void {
    const key = draftId.toPrimitive();

    // Cancel generator handle
    const handle = this.handles.get(key);
    if (handle) {
      handle.cancel();
      this.handles.delete(key);
    }

    // Remove from consensus
    this.consensus.removeBlock(draftId);

    // Transition to cancelled (removes from store)
    const draft = this.store.get(draftId);
    if (draft) {
      this.store.transition(draftId, 'cancelled');
    }
  }

  /**
   * Check a draft for margin-based cancellation.
   * Cancels when the draft's branch is losing by more than its own declaredWeight.
   */
  checkMargin(draftId: Hash): void {
    const draft = this.store.get(draftId);
    if (!draft) return;

    if (!this.consensus.isCanonical(draftId)) {
      // Draft is non-canonical -- check the margin
      const draftWeight = this.consensus.getEffectiveWeight(draftId);
      const winner = this.consensus.getConflictWinner(draftId);

      if (!Hash.equals(winner, draftId)) {
        const winnerWeight = this.consensus.getEffectiveWeight(winner);
        const margin = winnerWeight - draftWeight;

        if (margin > draft.declaredWeight) {
          this.cancelDraft(draftId);
        }
      }
    }
  }

  /**
   * Handle canonicality changes. Called from consensus listener.
   * Checks margin-based cancellation for non-canonical drafts.
   */
  onCanonicalityChange(hash: Hash, canonical: boolean): void {
    if (canonical) return;

    // Only care about our drafts
    const draft = this.store.get(hash);
    if (!draft) return;

    this.checkMargin(hash);
  }
}
