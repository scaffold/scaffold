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
  readonly spec: GenerationSpec;
  canonical: boolean;
}

/** Fields describing a generation target. */
export interface GenerationSpec {
  readonly targetKey: TargetKey;
  readonly anchor: Hash;
  readonly verifier: Verifier;
  readonly declaredWeight: number;
}

/**
 * Provider interface. The module delegates restart to the caller's
 * environment, keeping the module itself concerned only with target-
 * based tracking and priority.
 */
export interface GenerationProvider {
  /**
   * Notify the caller that a draft became non-canonical and a restart is
   * needed. Implementations typically allocate a new draft (via
   * DraftManager or equivalent) and re-register it via `register`. The
   * module does not force a specific mechanism.
   */
  requestRestart(previousDraftId: Hash, spec: GenerationSpec): void;
}

// -- Module ---------------------------------------------------------

/**
 * Tracks in-progress generation drafts and orchestrates restart-on-
 * uncanonical. The module does NOT own draft creation, contract
 * execution, queue scheduling, or consensus wiring -- those are the
 * service's job (see `GenerationService`).
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
   * Register a draft the caller has already created (via DraftManager or
   * equivalent) as an in-progress generation for the given spec.
   *
   * Tracking the draft means:
   *  - `priority(draftId)` returns the draft's current priority.
   *  - `onCanonicalityChange(draftId, false)` triggers `provider.requestRestart`.
   *  - The draft is visible to `draftsForTarget(targetKey)`.
   *
   * If `targetKey` already has tracked drafts, the new entry coexists --
   * the caller is typically restarting. The module does not cancel the
   * old draft.
   */
  register(draftId: Hash, spec: GenerationSpec): void {
    this._drafts.set(draftId.toPrimitive(), {
      draftId,
      spec,
      // Draft is assumed canonical at creation; consensus will revise if not.
      canonical: true,
    });
  }

  /**
   * Read callback for canonicality updates. Called by the service when
   * consensus's `onCanonicalityChange` fires on one of our drafts.
   *
   * Flipping to `false`: update entry, ask provider to restart. The
   * provider is responsible for allocating a new draft and calling
   * `register` on it.
   *
   * Flipping to `true`: update entry. Priority naturally returns to full.
   */
  onCanonicalityChange(draftId: Hash, canonical: boolean): void {
    const entry = this._drafts.get(draftId.toPrimitive());
    if (!entry) return;
    if (entry.canonical === canonical) return;

    entry.canonical = canonical;
    if (!canonical) {
      this._provider.requestRestart(draftId, entry.spec);
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
    const base = entry.spec.declaredWeight;
    return entry.canonical ? base : base * this._uncanonicalFactor;
  }

  /**
   * Remove a draft from the module's registry. Call on publication (the
   * draft has been converted to a real block) or explicit cancellation.
   * Does not cancel the draft in the draft store or consensus -- callers
   * own that.
   */
  forget(draftId: Hash): void {
    this._drafts.delete(draftId.toPrimitive());
  }

  /** Return all tracked draft ids for a given target, in no particular order. */
  draftsForTarget(targetKey: TargetKey): Hash[] {
    const out: Hash[] = [];
    for (const entry of this._drafts.values()) {
      if (entry.spec.targetKey === targetKey) out.push(entry.draftId);
    }
    return out;
  }

  /** Spec associated with a tracked draft, or undefined. */
  getSpec(draftId: Hash): GenerationSpec | undefined {
    return this._drafts.get(draftId.toPrimitive())?.spec;
  }

  /** True if at least one draft for the given target is currently tracked. */
  hasActiveTarget(targetKey: TargetKey): boolean {
    for (const entry of this._drafts.values()) {
      if (entry.spec.targetKey === targetKey) return true;
    }
    return false;
  }

  /** Number of drafts currently tracked. */
  get size(): number {
    return this._drafts.size;
  }
}
