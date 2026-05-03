// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';
import type { OutputSlot } from './GeneratingEnv.ts';
import type { ClaimRef, Node } from './Node.ts';

// -- Draft merger disjointness ------------------------------------

/**
 * Two drafts are mergeable into a single block only if the sets of
 * output namespaces owned by their claims are disjoint. Overlapping
 * namespaces would collide the block-level partition check
 * (see docs/protocol/computation.md#output-namespaces).
 *
 * `namespacesForDraft` maps a draft to the union of its claims'
 * contracts' declared outputNamespaces -- typically callers pass a
 * closure over `ContractHost.getOutputNamespaces` + the draft's
 * resolvedClaims' verifiers.
 */
export function draftsAreMergeable(
  a: Hash[],
  b: Hash[],
): boolean {
  const keys = new Set(a.map((h) => h.toPrimitive()));
  for (const h of b) {
    if (keys.has(h.toPrimitive())) return false;
  }
  return true;
}

// -- Types --------------------------------------------------------

/** Unique identifier for a draft. */
export type DraftId = Hash;

/** Draft lifecycle status. */
export type DraftStatus = 'pending' | 'generating' | 'ready' | 'cancelled';

/**
 * A claim with known economic value. Transit type used by the generation
 * pipeline (GeneratingEnv, GeneratingRunResult) to carry per-input value
 * from the moment a contract consumes an input to the moment the draft
 * is created. NOT stored on Draft itself -- once a draft exists, value
 * is looked up on demand from the producing block in the store.
 */
export interface ClaimIntent {
  /** Hash of the block containing the claimed output. */
  readonly block: Hash;
  /** Index into that block's output array. */
  readonly outputIndex: number;
  /** Economic value of the claimed output. */
  readonly value: number;
}

/**
 * Local-only placeholder for a block being constructed.
 *
 * Satisfies the `Node` interface (`kind`, `outputs`, `claims`,
 * `effectiveWeight`) so ConsensusModule, OutputClaimModule, weight
 * propagation, and UtxoIndex can treat drafts uniformly with blocks.
 *
 * The shape today is transitional: `anchor`, `aggregates`,
 * `includeConstraints`, and the simple `status` string are still here
 * for back-compat with consumers that haven't migrated. Subsequent steps
 * (BlockBuilderModule, lifecycle state machine) move callers off these
 * fields, after which they can be dropped.
 */
export interface Draft {
  // -- Node-projection fields ----------------------------------------
  /** Discriminator for the `Node` union. */
  readonly kind: 'draft';
  /**
   * Direct `(producer, outputIndex)` references for every input this
   * draft consumes. Drafts only run when their producing blocks are
   * present in the local store, so claims are always fully resolved
   * (each `outputIndex < producer.outputs.length`). Mutable so the
   * generator can append claims as it runs (requireInput / collectInputs).
   *
   * Economic value of a claim is not stored here; it is looked up on
   * demand from `store.get(producer).outputs[outputIndex].value`.
   */
  readonly claims: ClaimRef[];
  /**
   * Live, sampled weight used by ConsensusModule to pick the canonical
   * draft when multiple drafts claim the same outputs. Wall-clock based
   * (planned: bumped on a ~1s tick by a `DraftWeightTicker`); initialized
   * to 0. Block weight uses a different scale (declared + sampled
   * subtree); both kinds compete on this field.
   */
  effectiveWeight: number;

  // -- Existing fields (some legacy, some still load-bearing) --------
  readonly draftId: DraftId;
  readonly outputs: Output[];
  /**
   * Slot-tagged outputs (origin: 'require' | 'get'), in call order,
   * parallel to `outputs`. Used at solidification to identify slots
   * whose `value` may be overridden. Populated from `GeneratingRunResult.outputSlots`.
   */
  readonly outputSlots: OutputSlot[];
  readonly declaredWeight: number;
  readonly anchor: Hash;
  readonly refs: Hash[];
  readonly aggregates: Hash[];
  /** Blocks that must appear in the final subtree (accumulated by requireInput). */
  readonly includeConstraints: Hash[];
  readonly status: DraftStatus;
}

// Compile-time assertion: Draft satisfies the Node interface.
// (Type-only; the assignment is never executed.)
const _draftIsNode: Node = undefined as unknown as Draft;
void _draftIsNode;

// -- Valid transitions --------------------------------------------

const VALID_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  pending: ['generating', 'cancelled'],
  generating: ['ready', 'cancelled'],
  ready: ['cancelled'],
  cancelled: [],
};

// -- Factory ------------------------------------------------------

/** Create a new Draft with a random draftId and 'pending' status. */
export function createDraft(fields: {
  claims: ClaimRef[];
  outputs: Output[];
  outputSlots?: OutputSlot[];
  declaredWeight: number;
  anchor: Hash;
  refs?: Hash[];
  aggregates?: Hash[];
  includeConstraints?: Hash[];
}): Draft {
  return {
    kind: 'draft',
    claims: fields.claims,
    effectiveWeight: 0,
    draftId: Hash.random(),
    outputs: fields.outputs,
    // Default slots: treat any pre-populated outputs as 'require' origin.
    // Generation fills this in via `_applyResult`; other entry points
    // (e.g., test fixtures, phantom drafts) get a sensible default.
    outputSlots: fields.outputSlots ??
      fields.outputs.map((output) => ({ output, origin: 'require' as const })),
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
  private readonly drafts = new Map<HashPrimitive, Draft>();
  private readonly _transitionListeners: ((draft: Draft) => void)[] = [];

  /** Register a listener that fires after any status transition. Returns an unsubscribe function. */
  onTransition(cb: (draft: Draft) => void): () => void {
    this._transitionListeners.push(cb);
    return () => {
      const i = this._transitionListeners.indexOf(cb);
      if (i >= 0) this._transitionListeners.splice(i, 1);
    };
  }

  get size(): number {
    return this.drafts.size;
  }

  add(draft: Draft): void {
    const key = draft.draftId.toPrimitive();
    if (this.drafts.has(key)) {
      throw new Error(`Draft ${key} already exists`);
    }
    this.drafts.set(key, draft);
  }

  get(draftId: Hash): Draft | undefined {
    return this.drafts.get(draftId.toPrimitive());
  }

  remove(draftId: Hash): void {
    this.drafts.delete(draftId.toPrimitive());
  }

  getAll(): Draft[] {
    return [...this.drafts.values()];
  }

  getByStatus(status: DraftStatus): Draft[] {
    return this.getAll().filter((d) => d.status === status);
  }

  /**
   * Transition a draft to a new status. Returns a new immutable draft object.
   * Validates the state machine. Transition to 'cancelled' removes the draft.
   */
  transition(draftId: Hash, newStatus: DraftStatus): Draft {
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

    const updated: Draft = { ...existing, status: newStatus };

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
    changes: Partial<Omit<Draft, 'draftId' | 'status'>>,
  ): Draft {
    const key = draftId.toPrimitive();
    const existing = this.drafts.get(key);
    if (!existing) {
      throw new Error(`Draft ${key} not found`);
    }

    const updated: Draft = { ...existing, ...changes };
    this.drafts.set(key, updated);
    return updated;
  }

  /**
   * Delete old draft and create a new one with a new draftId and merged fields.
   * Status defaults to 'pending'.
   */
  recreate(
    draftId: Hash,
    changes: Partial<Omit<Draft, 'draftId' | 'status'>>,
  ): Draft {
    const key = draftId.toPrimitive();
    const existing = this.drafts.get(key);
    if (!existing) {
      throw new Error(`Draft ${key} not found`);
    }

    this.drafts.delete(key);

    const newDraft: Draft = {
      ...existing,
      ...changes,
      draftId: Hash.random(),
      status: 'pending',
    };

    this.drafts.set(newDraft.draftId.toPrimitive(), newDraft);
    return newDraft;
  }
}
