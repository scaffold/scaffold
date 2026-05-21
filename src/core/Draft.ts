// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Output } from './BlockCreationModule.ts';
import type { OutputSlot } from './GeneratingEnv.ts';
import type { ClaimRef, Node } from './Node.ts';
import type { Block } from './Block.ts';

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
 * claims' verifiers.
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

/**
 * Draft lifecycle status. Discriminated union so terminal states can
 * carry context.
 *
 *   populating  -- producer is filling the draft in place. The only
 *                  phase in which `update` is legal.
 *   ready       -- producer has handed off. Eligible for merging into
 *                  a solidifying batch; the manager will NOT solidify
 *                  it on its own.
 *   solidifying -- producer requested solidify (or retry loop is
 *                  re-attempting). Manager keeps retrying on canonicality
 *                  changes until it succeeds.
 *   solidified  -- at least one block has been produced. Carries the
 *                  latest block. NOT terminal: if the carried block
 *                  becomes uncanonical, the draft transitions back to
 *                  `solidifying` and the manager retries with a new
 *                  anchor, appending the new block to `solidifiedBlocks`.
 *   cancelled   -- terminal. Reached only via explicit cancel (producer
 *                  hard-error, user cancel, etc).
 */
export type DraftStatus =
  | { phase: 'populating' }
  | { phase: 'ready' }
  | { phase: 'solidifying' }
  | { phase: 'solidified'; block: Block }
  | { phase: 'cancelled'; reason: string };

/** Terminal status check. Only `cancelled` is terminal. */
export function isDraftTerminal(s: DraftStatus): boolean {
  return s.phase === 'cancelled';
}

/** Convenience: phase string of a DraftStatus. */
export function statusPhase(s: DraftStatus): DraftStatus['phase'] {
  return s.phase;
}

/**
 * Local-only placeholder for a block being constructed.
 *
 * Satisfies the `Node` interface (`kind`, `outputs`, `claims`,
 * `effectiveWeight`) so ConsensusModule, OutputClaimModule, weight
 * propagation, and UtxoIndex can treat drafts uniformly with blocks.
 *
 * The anchor is **not** stored here. `BlockBuilderModule.build` picks
 * an anchor at solidification time as the deepest common ancestor of
 * all claim producers. The `aggregates` set is similarly derived
 * (producers not on the chosen anchor's chain). `includeConstraints`
 * is redundant with `claims` (since `unique(claims.map(c => c.producer))`
 * is the include set) and was removed.
 *
 * The `draftId` field is retained for now -- it is the consensus-side
 * identity used by ConsensusModule to register drafts as phantom
 * blocks. Once consensus admits Nodes by object equality, draftId can
 * be dropped.
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
   * generator can append claims as it runs (claimNext / claimAll).
   *
   * A draft with no claims will produce blocks that may not be
   * canonical-exclusive (i.e. multiple of them may become canonical
   * at the same time).
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

  // -- Other fields --------------------------------------------------
  readonly draftId: DraftId;
  readonly outputs: Output[];
  /**
   * Slot-tagged outputs (origin: 'require' | 'get'), in call order,
   * parallel to `outputs`. Used at solidification to identify slots
   * whose `value` may be overridden. Populated from `GeneratingRunResult.outputSlots`.
   */
  readonly outputSlots: OutputSlot[];
  readonly declaredWeight: number;
  readonly refs: Hash[];
  readonly status: DraftStatus;
  /**
   * Every block this draft has solidified into, oldest first. Invariant:
   * for drafts with `claims.length > 0`, at most one entry is canonical
   * at any moment. Zero-claim drafts are exempt (multiple may be
   * canonical simultaneously). Mutated only by DraftManager.
   *
   * Populated starting in chunk 3 of the consolidation refactor; for
   * now this is reserved as a forward-compatibility field and stays
   * empty -- the latest block lives in `status.block` when
   * `status.phase === 'solidified'`.
   */
  readonly solidifiedBlocks: Block[];
}

// Compile-time assertion: Draft satisfies the Node interface.
// (Type-only; the assignment is never executed.)
void (({} as Draft) satisfies Node);

// -- Valid transitions --------------------------------------------
//
// Transitions are validated by phase. `cancelled` is terminal -- a draft
// that hits it stays there permanently so we don't relaunch its
// generator and so debug tools can answer "what happened?".
//
// `solidified` is NOT terminal: if the produced block becomes uncanonical,
// DraftManager transitions the draft back to `solidifying` and retries
// with a new anchor.

type Phase = DraftStatus['phase'];

const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  populating: ['ready', 'solidifying', 'cancelled'],
  ready: ['solidifying', 'cancelled'],
  solidifying: ['solidified', 'cancelled'],
  solidified: ['solidifying', 'cancelled'],
  cancelled: [],
};

// -- Factory ------------------------------------------------------

/** Create a new Draft with a random draftId and 'populating' status. */
export function createDraft(fields: {
  claims: ClaimRef[];
  outputs: Output[];
  outputSlots?: OutputSlot[];
  declaredWeight: number;
  refs?: Hash[];
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
    refs: fields.refs ?? [],
    status: { phase: 'populating' },
    solidifiedBlocks: [],
  };
}

// -- DraftStore ---------------------------------------------------

/** In-memory store for block drafts. Immutable transitions. */
export class DraftStore {
  private readonly drafts = new Map<HashPrimitive, Draft>();
  private readonly _transitionListeners: ((draft: Draft) => void)[] = [];
  private readonly _addListeners: ((draft: Draft) => void)[] = [];

  /** Register a listener that fires after any status transition. Returns an unsubscribe function. */
  onTransition(cb: (draft: Draft) => void): () => void {
    this._transitionListeners.push(cb);
    return () => {
      const i = this._transitionListeners.indexOf(cb);
      if (i >= 0) this._transitionListeners.splice(i, 1);
    };
  }

  /** Register a listener that fires after a new draft is inserted via `add()`. */
  onAdded(cb: (draft: Draft) => void): () => void {
    this._addListeners.push(cb);
    return () => {
      const i = this._addListeners.indexOf(cb);
      if (i >= 0) this._addListeners.splice(i, 1);
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
    for (const cb of this._addListeners) cb(draft);
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

  getByPhase(phase: Phase): Draft[] {
    return this.getAll().filter((d) => d.status.phase === phase);
  }

  /**
   * Transition a draft to a new status. Returns a new immutable draft
   * object. Validates the state machine. Drafts are NEVER removed by
   * transition -- terminal states (`solidified`, `cancelled`) persist
   * in the store as historical record. Use `remove()` if you really
   * need to drop a draft from the store.
   */
  transition(draftId: Hash, newStatus: DraftStatus): Draft {
    const key = draftId.toPrimitive();
    const existing = this.drafts.get(key);
    if (!existing) {
      throw new Error(`Draft ${key} not found`);
    }

    const allowed = VALID_TRANSITIONS[existing.status.phase];
    if (!allowed.includes(newStatus.phase)) {
      throw new Error(
        `Invalid transition: ${existing.status.phase} -> ${newStatus.phase}`,
      );
    }

    const updated: Draft = { ...existing, status: newStatus };
    this.drafts.set(key, updated);

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
}
