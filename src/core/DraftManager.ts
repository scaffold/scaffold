// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { BlockDraft, ClaimIntent, createDraft, DraftStore } from './BlockDraft.ts';
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
  private readonly _onDraftReady?: (draft: BlockDraft) => void;

  constructor(
    store: DraftStore,
    consensus: ConsensusModule<unknown>,
    generator: GeneratorProvider,
    opts?: { onDraftReady?: (draft: BlockDraft) => void },
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
    resolvedClaims: ClaimIntent[];
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

    // Transition to generating before starting the generator,
    // since the generator may synchronously transition to ready/cancelled.
    this.store.transition(draft.draftId, 'generating');

    // Start generation
    const handle = this.generator.generate(draft);
    this.handles.set(draft.draftId.toPrimitive(), handle);

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
}
