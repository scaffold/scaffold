// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Verifier } from '../core/BlockCreationModule.ts';

// -- Types ----------------------------------------------------------

/**
 * A logical target for generation. Two drafts with the same targetKey are
 * alternate attempts at the same generation work -- typically a restart
 * after one of the first draft's inputs became uncanonical.
 *
 * The key is opaque to the module; callers choose its shape. A simple
 * choice is `${verifier.contract}:${verifier.params}` (the verifier of
 * the incentive output being responded to).
 */
export type TargetKey = string;

/** One entry in the module's active-draft registry. */
interface DraftEntry {
  readonly draftId: Hash;
  readonly targetKey: TargetKey;
  readonly anchor: Hash;
  readonly verifier: Verifier;
  readonly declaredWeight: number;
  canonical: boolean;
}

/** Fields needed to start a generation. */
export interface GenerationSpec {
  readonly targetKey: TargetKey;
  readonly anchor: Hash;
  readonly verifier: Verifier;
  readonly declaredWeight: number;
}

/**
 * Provider interface. The module delegates draft creation, scheduling,
 * and canonicality queries to the caller's environment, keeping the
 * module itself concerned only with target-based lifecycle.
 */
export interface GenerationProvider {
  /**
   * Create a draft in the draft store, register it with consensus, and
   * return its id. The module passes through `anchor`, `verifier`, and
   * `declaredWeight` for the draft's initial state. The caller is
   * responsible for also enqueuing any work needed to produce the draft's
   * outputs -- the module does not own the execution queue.
   */
  createDraft(spec: GenerationSpec): Hash;

  /**
   * Notify the caller that a draft became non-canonical and a restart is
   * needed. Implementations typically call back into `startGeneration`
   * after gathering fresh inputs; the module does not force a specific
   * mechanism.
   */
  triggerRestart(previousDraftId: Hash, targetKey: TargetKey): void;
}

// -- Module ---------------------------------------------------------

/**
 * Tracks in-progress generation drafts and orchestrates restart-on-
 * uncanonical. The module does NOT own contract execution, queue
 * scheduling, or consensus wiring -- those are the service's job (see
 * `GenerationService`).
 *
 * Key invariants:
 *  - Old drafts are never implicitly cancelled. A draft that lost
 *    canonicality sits in the registry marked `canonical = false`; its
 *    `priority()` drops, and queue-level eviction (future work) reclaims
 *    it. Callers may explicitly untrack via `forget(draftId)` on publication
 *    or user-initiated cancellation.
 *  - Priority is read lazily via `priority(draftId)` so the queue can
 *    re-sort as canonicality evolves without bespoke notifications.
 *  - A canonicality flip to `false` triggers exactly one restart per
 *    transition. Flipping back to `true` does not auto-trigger a third
 *    draft; the previous one simply regains its full priority.
 */
export class GenerationModule {
  private readonly _provider: GenerationProvider;

  /** draftId -> entry. */
  private readonly _drafts = new Map<HashPrimitive, DraftEntry>();

  /** targetKey -> most recent draftId for that target. */
  private readonly _latestByTarget = new Map<TargetKey, Hash>();

  /**
   * Scale factor applied to priority when a draft is non-canonical.
   * Placeholder value -- see TODO.md ("GenerationModule Priority Calibration").
   */
  private readonly _uncanonicalFactor: number;

  constructor(provider: GenerationProvider, opts?: { uncanonicalFactor?: number }) {
    this._provider = provider;
    this._uncanonicalFactor = opts?.uncanonicalFactor ?? 0.1;
  }

  /**
   * Start a new generation for the given target. Creates a draft via the
   * provider, tracks it, and returns the new draft id.
   *
   * If `targetKey` already has an active draft, the new draft is
   * registered alongside it (caller is restarting). The module does not
   * cancel the old draft; it simply tracks both until untracked via
   * `forget`.
   */
  startGeneration(spec: GenerationSpec): Hash {
    const draftId = this._provider.createDraft(spec);

    this._drafts.set(draftId.toPrimitive(), {
      draftId,
      targetKey: spec.targetKey,
      anchor: spec.anchor,
      verifier: spec.verifier,
      declaredWeight: spec.declaredWeight,
      // Draft is assumed canonical at creation; consensus will revise if not.
      canonical: true,
    });
    this._latestByTarget.set(spec.targetKey, draftId);
    return draftId;
  }

  /**
   * Read callback for canonicality updates. Called by the service when
   * consensus's `onCanonicalityChange` fires on one of our drafts.
   *
   * Flipping to `false`: update entry, ask provider to restart. The
   * provider is responsible for calling `startGeneration` with fresh inputs.
   *
   * Flipping to `true`: update entry. Priority naturally returns to full.
   */
  onCanonicalityChange(draftId: Hash, canonical: boolean): void {
    const entry = this._drafts.get(draftId.toPrimitive());
    if (!entry) return;
    if (entry.canonical === canonical) return;

    entry.canonical = canonical;
    if (!canonical) {
      this._provider.triggerRestart(draftId, entry.targetKey);
    }
  }

  /**
   * Scheduling priority for the given draft. Returns 0 if unknown. Queue
   * callers pass a thunk `() => module.priority(draftId)` as the
   * Executable's priority().
   */
  priority(draftId: Hash): number {
    const entry = this._drafts.get(draftId.toPrimitive());
    if (!entry) return 0;
    const base = entry.declaredWeight;
    return entry.canonical ? base : base * this._uncanonicalFactor;
  }

  /**
   * Remove a draft from the module's registry. Call on publication (the
   * draft has been converted to a real block) or explicit cancellation.
   * Does not cancel the draft in the draft store or consensus -- callers
   * own that.
   */
  forget(draftId: Hash): void {
    const key = draftId.toPrimitive();
    const entry = this._drafts.get(key);
    if (!entry) return;
    this._drafts.delete(key);
    if (this._latestByTarget.get(entry.targetKey)?.toPrimitive() === key) {
      this._latestByTarget.delete(entry.targetKey);
    }
  }

  /** Return all tracked draft ids for a given target, in no particular order. */
  draftsForTarget(targetKey: TargetKey): Hash[] {
    const out: Hash[] = [];
    for (const entry of this._drafts.values()) {
      if (entry.targetKey === targetKey) out.push(entry.draftId);
    }
    return out;
  }

  /** Number of drafts currently tracked. */
  get size(): number {
    return this._drafts.size;
  }
}
