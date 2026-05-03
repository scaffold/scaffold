// Protocol spec: docs/protocol/draft-blocks.md

import { Draft, DraftId } from './Draft.ts';
import { HashPrimitive } from '../util/Hash.ts';

/** Handle returned by a generator for a running generation. */
export interface GeneratorHandle {
  readonly draftId: DraftId;
  cancel(): void;
}

/** Provider interface for generators that produce blocks from drafts. */
export interface GeneratorProvider {
  generate(draft: Draft): GeneratorHandle;
}

/**
 * Stub generator for testing. Records generate/cancel signals
 * without performing real computation.
 */
export class StubGenerator implements GeneratorProvider {
  readonly active = new Map<HashPrimitive, Draft>();
  readonly cancelled = new Set<HashPrimitive>();

  generate(draft: Draft): GeneratorHandle {
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
