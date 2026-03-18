// Protocol spec: docs/protocol/draft-blocks.md

import { BlockDraft, DraftID } from './BlockDraft.ts';
import { HashPrimitive } from '../util/Hash.ts';

/** Handle returned by a generator for a running generation. */
export interface GeneratorHandle {
  readonly draftId: DraftID;
  cancel(): void;
}

/** Provider interface for generators that produce blocks from drafts. */
export interface GeneratorProvider {
  generate(draft: BlockDraft): GeneratorHandle;
}

/**
 * Stub generator for testing. Records generate/cancel signals
 * without performing real computation.
 */
export class StubGenerator implements GeneratorProvider {
  readonly active = new Map<HashPrimitive, BlockDraft>();
  readonly cancelled = new Set<HashPrimitive>();

  generate(draft: BlockDraft): GeneratorHandle {
    const key = draft.draftId.toPrimitive();
    this.active.set(key, draft);

    return {
      draftId: draft.draftId,
      cancel: () => {
        this.active.delete(key);
        this.cancelled.add(key);
      },
    };
  }
}
