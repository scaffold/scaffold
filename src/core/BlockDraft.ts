// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';

// -- Types --------------------------------------------------------

/** Unique identifier for a draft. */
export type DraftID = Hash;

/** Draft lifecycle status. */
export type DraftStatus = 'pending' | 'generating' | 'ready' | 'cancelled';

/**
 * A claim with known economic value, used during draft/block construction.
 * Produced by the draft system (GeneratingEnv, DraftStrategy) which has
 * access to UTXO values. Value is needed for throughput balancing.
 */
export interface ClaimIntent {
  /** Hash of the block containing the claimed output. */
  readonly block: Hash;
  /** Index into that block's output array. */
  readonly outputIndex: number;
  /** Economic value of the claimed output. */
  readonly value: number;
}

/** Local-only placeholder for a block being constructed. */
export interface BlockDraft {
  readonly draftId: DraftID;
  readonly resolvedClaims: ClaimIntent[];
  readonly outputs: Output[];
  readonly declaredWeight: number;
  readonly anchor: Hash;
  readonly refs: Hash[];
  readonly aggregates: Hash[];
  /** Blocks that must appear in the final subtree (accumulated by requireInput). */
  readonly includeConstraints: Hash[];
  readonly status: DraftStatus;
}

// -- Valid transitions --------------------------------------------

const VALID_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  pending: ['generating', 'cancelled'],
  generating: ['ready', 'cancelled'],
  ready: ['cancelled'],
  cancelled: [],
};

// -- Factory ------------------------------------------------------

/** Create a new BlockDraft with a random draftId and 'pending' status. */
export function createDraft(fields: {
  resolvedClaims: ClaimIntent[];
  outputs: Output[];
  declaredWeight: number;
  anchor: Hash;
  refs?: Hash[];
  aggregates?: Hash[];
  includeConstraints?: Hash[];
}): BlockDraft {
  return {
    draftId: Hash.random(),
    resolvedClaims: fields.resolvedClaims,
    outputs: fields.outputs,
    declaredWeight: fields.declaredWeight,
    anchor: fields.anchor,
    refs: fields.refs ?? [],
    aggregates: fields.aggregates ?? [],
    includeConstraints: fields.includeConstraints ?? [],
    status: 'pending',
  };
}

// -- DraftStore ---------------------------------------------------

/** In-memory store for block drafts. Immutable transitions. */
export class DraftStore {
  private readonly drafts = new Map<HashPrimitive, BlockDraft>();
  private readonly _transitionListeners: ((draft: BlockDraft) => void)[] = [];

  /** Register a listener that fires after any status transition. Returns an unsubscribe function. */
  onTransition(cb: (draft: BlockDraft) => void): () => void {
    this._transitionListeners.push(cb);
    return () => {
      const i = this._transitionListeners.indexOf(cb);
      if (i >= 0) this._transitionListeners.splice(i, 1);
    };
  }

  get size(): number {
    return this.drafts.size;
  }

  add(draft: BlockDraft): void {
    const key = draft.draftId.toPrimitive();
    if (this.drafts.has(key)) {
      throw new Error(`Draft ${key} already exists`);
    }
    this.drafts.set(key, draft);
  }

  get(draftId: Hash): BlockDraft | undefined {
    return this.drafts.get(draftId.toPrimitive());
  }

  remove(draftId: Hash): void {
    this.drafts.delete(draftId.toPrimitive());
  }

  getAll(): BlockDraft[] {
    return [...this.drafts.values()];
  }

  getByStatus(status: DraftStatus): BlockDraft[] {
    return this.getAll().filter((d) => d.status === status);
  }

  /**
   * Transition a draft to a new status. Returns a new immutable draft object.
   * Validates the state machine. Transition to 'cancelled' removes the draft.
   */
  transition(draftId: Hash, newStatus: DraftStatus): BlockDraft {
    const key = draftId.toPrimitive();
    const existing = this.drafts.get(key);
    if (!existing) {
      throw new Error(`Draft ${key} not found`);
    }

    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${existing.status} -> ${newStatus}`,
      );
    }

    const updated: BlockDraft = { ...existing, status: newStatus };

    if (newStatus === 'cancelled') {
      this.drafts.delete(key);
    } else {
      this.drafts.set(key, updated);
    }

    for (const cb of this._transitionListeners) cb(updated);

    return updated;
  }

  /**
   * Update a draft in-place with merged fields. Keeps the same draftId and status.
   */
  update(
    draftId: Hash,
    changes: Partial<Omit<BlockDraft, 'draftId' | 'status'>>,
  ): BlockDraft {
    const key = draftId.toPrimitive();
    const existing = this.drafts.get(key);
    if (!existing) {
      throw new Error(`Draft ${key} not found`);
    }

    const updated: BlockDraft = { ...existing, ...changes };
    this.drafts.set(key, updated);
    return updated;
  }

  /**
   * Delete old draft and create a new one with a new draftId and merged fields.
   * Status defaults to 'pending'.
   */
  recreate(
    draftId: Hash,
    changes: Partial<Omit<BlockDraft, 'draftId' | 'status'>>,
  ): BlockDraft {
    const key = draftId.toPrimitive();
    const existing = this.drafts.get(key);
    if (!existing) {
      throw new Error(`Draft ${key} not found`);
    }

    this.drafts.delete(key);

    const newDraft: BlockDraft = {
      ...existing,
      ...changes,
      draftId: Hash.random(),
      status: 'pending',
    };

    this.drafts.set(newDraft.draftId.toPrimitive(), newDraft);
    return newDraft;
  }
}
