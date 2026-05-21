// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { createDraft, Draft, DraftId, DraftStore, isDraftTerminal } from './Draft.ts';
import type { OutputSlot } from './GeneratingEnv.ts';
import type { ClaimRef } from './Node.ts';
import { Output } from './BlockCreationModule.ts';
import { ConsensusModule } from './ConsensusModule.ts';
import { type GeneratorHandle, type GeneratorProvider } from './Generator.ts';
import type { Block } from './Block.ts';
import type { BlockBuilderModule } from './BlockBuilderModule.ts';

/**
 * Outcome of a `solidify` call. Mirrors `BlockBuilderModule.BuildResult`
 * but adds the consumed-draft list so callers can correlate the produced
 * block with the seed batch.
 */
export type SolidifyResult =
  | { ok: true; block: Block; consumedDraftIds: Hash[] }
  | { ok: false; awaitingAnchor: true; missing: Hash[] }
  | { ok: false; reason: string };

/**
 * Orchestrates the draft lifecycle: creation, consensus registration,
 * generator dispatch, and the draft-to-block solidify pipeline.
 *
 * The solidify path is the single funnel through which any caller turns
 * one or more drafts into a block. PutManager and the post-generation
 * hook are the primary callers; eventually all `createBlock`-flavoured
 * action paths in ReactiveLayer route through here.
 */
export class DraftManager {
  private readonly store: DraftStore;
  private readonly consensus: ConsensusModule<unknown>;
  private readonly generator?: GeneratorProvider;
  private readonly handles = new Map<HashPrimitive, GeneratorHandle>();
  private readonly _onDraftReady?: (draft: Draft) => void;
  private readonly _blockBuilder?: BlockBuilderModule;
  private readonly _processBlock?: (block: Block) => void;

  constructor(
    store: DraftStore,
    consensus: ConsensusModule<unknown>,
    generator?: GeneratorProvider,
    opts?: {
      onDraftReady?: (draft: Draft) => void;
      blockBuilder?: BlockBuilderModule;
      processBlock?: (block: Block) => void;
    },
  ) {
    this.store = store;
    this.consensus = consensus;
    this.generator = generator;
    this._onDraftReady = opts?.onDraftReady;
    this._blockBuilder = opts?.blockBuilder;
    this._processBlock = opts?.processBlock;

    // Retry loop: when canonicality shifts, retry every solidifying
    // draft and demote any solidified draft whose carried block is no
    // longer canonical (so its content can be republished against a
    // new anchor).
    if (this._blockBuilder) {
      this.consensus.onCanonicalityChange(() => this._retrySolidifying());
    }
  }

  private _retrySolidifying(): void {
    if (!this._blockBuilder) return;
    if (this._retrying) return; // re-entrancy guard: solidify -> processBlock -> canonicality change
    this._retrying = true;
    this._solidifyDepth++;
    try {
      // Demote solidified drafts where no entry in `solidifiedBlocks`
      // is currently canonical. Zero-claim drafts are exempt: their
      // produced blocks may all be canonical simultaneously (see
      // Draft.ts claims docstring), so we don't track exclusivity.
      for (const d of this.store.getByPhase('solidified')) {
        if (d.claims.length === 0) continue;
        if (d.solidifiedBlocks.length === 0) continue;
        const anyCanonical = d.solidifiedBlocks.some((b) =>
          this.consensus.isCanonical(b.hash)
        );
        if (!anyCanonical) {
          // Re-register the phantom and transition back to solidifying.
          this.consensus.addBlock(d.draftId);
          this.consensus.setVerifiedWeight(d.draftId, [d.declaredWeight]);
          this.store.transition(d.draftId, { phase: 'solidifying' });
        }
      }
      // Retry every solidifying draft.
      for (const d of this.store.getByPhase('solidifying')) {
        this.solidify([d]);
      }
    } finally {
      this._solidifyDepth--;
      this._retrying = false;
    }
  }

  /**
   * For a previously-solidified block of one of our drafts, find every
   * canonical block that "witnesses" its loss -- typically the canonical
   * partner in a direct conflict. Returns `[]` when no specific
   * witness is identifiable (e.g. the previous block lost on branch
   * weight without a direct claim collision).
   *
   * Currently implements step 1 only (direct conflicts via
   * `consensus.getConflicts`). Step 2 (anchor-chain walk for indirect
   * losses) is not yet implemented -- placement's standard logic against
   * the current canonical view handles the indirect case adequately
   * here. Returning every canonical conflict (not just one) handles the
   * legitimate case where a block has multiple direct-conflict partners
   * that don't conflict with each other and so can all be canonical.
   */
  private _findCanonicalConflictWitnesses(blockHash: Hash): Hash[] {
    const conflicts = this.consensus.getConflicts(blockHash);
    const canonical: Hash[] = [];
    for (const cKey of conflicts) {
      const cHash = Hash.fromPrimitive(cKey);
      if (this.consensus.isCanonical(cHash)) canonical.push(cHash);
    }
    return canonical;
  }

  /**
   * Compute the placement opts to feed BlockBuilderModule.solidify for a
   * draft that is being re-solidified. Implements the simplified
   * single-branch algorithm from the consolidation plan:
   *
   *   - aggregatedBlocks: dedupe witnesses for each prior block.
   *     These force the new block to include the witnesses in its
   *     aggregates, ensuring direct-claim collisions emerge structurally
   *     and indirect losses become descendants of the winning branch.
   *   - excludedBlocks: every prior block from this draft, so placement
   *     refuses to re-anchor at any of our own losing attempts (each
   *     retry produces a fresh hash).
   *
   * Returns empty opts on the first attempt (solidifiedBlocks empty).
   */
  private _mergeResolidifyOpts(perDraft: Array<{
    aggregatedBlocks: Hash[];
    excludedBlocks: Hash[];
  }>): { aggregatedBlocks: Hash[]; excludedBlocks: Hash[] } {
    const aggSeen = new Set<string>();
    const aggregatedBlocks: Hash[] = [];
    const excSeen = new Set<string>();
    const excludedBlocks: Hash[] = [];
    for (const o of perDraft) {
      for (const h of o.aggregatedBlocks) {
        const k = h.toHex();
        if (aggSeen.has(k)) continue;
        aggSeen.add(k);
        aggregatedBlocks.push(h);
      }
      for (const h of o.excludedBlocks) {
        const k = h.toHex();
        if (excSeen.has(k)) continue;
        excSeen.add(k);
        excludedBlocks.push(h);
      }
    }
    return { aggregatedBlocks, excludedBlocks };
  }

  private _computeResolidifyOpts(d: Draft): {
    aggregatedBlocks: Hash[];
    excludedBlocks: Hash[];
  } {
    if (d.solidifiedBlocks.length === 0) {
      return { aggregatedBlocks: [], excludedBlocks: [] };
    }
    const witnessSet = new Set<string>();
    const witnesses: Hash[] = [];
    for (const b of d.solidifiedBlocks) {
      for (const w of this._findCanonicalConflictWitnesses(b.hash)) {
        const key = w.toHex();
        if (witnessSet.has(key)) continue;
        witnessSet.add(key);
        witnesses.push(w);
      }
    }
    return {
      aggregatedBlocks: witnesses,
      excludedBlocks: d.solidifiedBlocks.map((b) => b.hash),
    };
  }
  private _retrying = false;

  /**
   * Re-entrancy guard for the auto-solidify-on-transition listener
   * installed by NodeContext. Set true while solidify (or the retry
   * loop) is running so the listener doesn't recursively call solidify
   * on transitions we initiated ourselves. Callers outside this class
   * read it via `isSolidifyActive`.
   */
  private _solidifyDepth = 0;

  /** True while a solidify or retry pass is currently in progress. */
  isSolidifyActive(): boolean {
    return this._solidifyDepth > 0;
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
    if (!this.generator) {
      throw new Error('DraftManager.createDraft: no GeneratorProvider configured');
    }
    const draft = createDraft(fields);
    this.store.add(draft);

    // Register in consensus as a phantom block
    this.consensus.addBlock(draft.draftId);
    this.consensus.setVerifiedWeight(draft.draftId, [draft.declaredWeight]);

    // Draft starts in `populating` and stays there until the generator
    // finishes. No separate transition needed.

    // Start generation
    const handle = this.generator.generate(draft);
    this.handles.set(draft.draftId.toPrimitive(), handle);

    return draft;
  }

  /** Look up a draft by id, if it's still in the store. */
  get(draftId: Hash): Draft | undefined {
    return this.store.get(draftId);
  }

  // ====================================================================
  // Producer-agnostic API (final target shape; chunks 6-8 migrate
  // legacy callers off the methods below into these.)
  // ====================================================================

  /**
   * Create a draft in `populating`. The caller (a producer like a generator,
   * PutManager, FetchManager) owns the draft until it calls `markReady` or
   * `markSolidifying`. Registers the draft as a phantom block in consensus.
   *
   * Unlike `createDraft`, this does NOT start the generator: producers are
   * responsible for their own work (running a contract, populating outputs
   * synchronously, etc.) and incrementally pushing content via `update`.
   */
  create(fields?: {
    claims?: ClaimRef[];
    outputs?: Output[];
    outputSlots?: OutputSlot[];
    declaredWeight?: number;
    refs?: Hash[];
  }): Draft {
    const draft = createDraft({
      claims: fields?.claims ?? [],
      outputs: fields?.outputs ?? [],
      outputSlots: fields?.outputSlots,
      declaredWeight: fields?.declaredWeight ?? 0,
      refs: fields?.refs,
    });
    this.store.add(draft);
    this.consensus.addBlock(draft.draftId);
    this.consensus.setVerifiedWeight(draft.draftId, [draft.declaredWeight]);
    return draft;
  }

  /**
   * Mutate a `populating` draft in place. `mode: 'append'` (default)
   * concatenates claims/outputs/outputSlots/refs; `mode: 'replace'`
   * overwrites. `declaredWeight` is monotone non-decreasing.
   *
   * Throws if the draft is not in `populating`.
   */
  updateDraft(
    draftId: DraftId,
    changes: {
      claims?: ClaimRef[];
      outputs?: Output[];
      outputSlots?: OutputSlot[];
      refs?: Hash[];
      declaredWeight?: number;
    },
    mode: 'append' | 'replace' = 'append',
  ): Draft {
    const existing = this.store.get(draftId);
    if (!existing) {
      throw new Error(`DraftManager.updateDraft: draft ${draftId.toHex().slice(0, 10)} not in store`);
    }
    if (existing.status.phase !== 'populating') {
      throw new Error(
        `DraftManager.updateDraft: draft ${draftId.toHex().slice(0, 10)} is locked (phase ${existing.status.phase})`,
      );
    }
    if (
      changes.declaredWeight !== undefined &&
      changes.declaredWeight < existing.declaredWeight
    ) {
      throw new Error(
        `DraftManager.updateDraft: declaredWeight is monotone non-decreasing (have ${existing.declaredWeight}, got ${changes.declaredWeight})`,
      );
    }

    const merged: {
      claims?: ClaimRef[];
      outputs?: Output[];
      outputSlots?: OutputSlot[];
      refs?: Hash[];
      declaredWeight?: number;
    } = {};
    if (changes.claims) {
      merged.claims = mode === 'append' ? [...existing.claims, ...changes.claims] : changes.claims;
    }
    if (changes.outputs) {
      merged.outputs = mode === 'append' ? [...existing.outputs, ...changes.outputs] : changes.outputs;
    }
    if (changes.outputSlots) {
      merged.outputSlots = mode === 'append'
        ? [...existing.outputSlots, ...changes.outputSlots]
        : changes.outputSlots;
    }
    if (changes.refs) {
      merged.refs = mode === 'append' ? [...existing.refs, ...changes.refs] : changes.refs;
    }
    if (changes.declaredWeight !== undefined) {
      merged.declaredWeight = changes.declaredWeight;
    }

    const updated = this.store.update(draftId, merged);
    if (changes.declaredWeight !== undefined) {
      this.consensus.setVerifiedWeight(draftId, [changes.declaredWeight]);
    }
    return updated;
  }

  /**
   * Producer hands off without requesting solidify: lock content, transition
   * `populating` -> `ready`. Eligible to be batched into a `solidify` call
   * (e.g. by piggyback aggregation) but the manager won't drive it itself.
   * Idempotent (no-op if already `ready` or beyond).
   */
  markReady(draftId: DraftId): Draft {
    const existing = this.store.get(draftId);
    if (!existing) {
      throw new Error(`DraftManager.markReady: draft ${draftId.toHex().slice(0, 10)} not in store`);
    }
    if (existing.status.phase === 'ready') return existing;
    if (existing.status.phase !== 'populating') {
      throw new Error(
        `DraftManager.markReady: cannot mark ready from phase ${existing.status.phase}`,
      );
    }
    return this.store.transition(draftId, { phase: 'ready' });
  }

  /**
   * Producer hands off AND demands solidify: transition from
   * `populating`/`ready` -> `solidifying` and synchronously attempt the
   * build. Idempotent (re-attempts if already in `solidifying`).
   */
  markSolidifying(draftId: DraftId): SolidifyResult {
    const existing = this.store.get(draftId);
    if (!existing) {
      return { ok: false, reason: `draft ${draftId.toHex().slice(0, 10)} not in store` };
    }
    if (existing.status.phase === 'cancelled' || existing.status.phase === 'solidified') {
      return { ok: false, reason: `draft is ${existing.status.phase}` };
    }
    // `populating` is not accepted by `solidify`; promote to `ready` first
    // so the next step in `solidify` can do the standard ready -> solidifying
    // transition. This keeps `solidify`'s precondition tight.
    const seed = existing.status.phase === 'populating'
      ? this.store.transition(draftId, { phase: 'ready' })
      : existing;
    return this.solidify([seed]);
  }

  /** Producer-agnostic cancel. Alias for the legacy `cancelDraft`. */
  cancel(draftId: DraftId, reason?: string): void {
    this.cancelDraft(draftId, reason);
  }

  /**
   * Synchronously create a draft already in `ready` (no generator
   * involvement). Used by PutManager and any caller that has all
   * claims/outputs decided up-front.
   */
  addReady(fields: {
    claims: ClaimRef[];
    outputs: Output[];
    declaredWeight: number;
    refs?: Hash[];
  }): Draft {
    const draft = createDraft(fields);
    this.store.add(draft);
    this.consensus.addBlock(draft.draftId);
    this.consensus.setVerifiedWeight(draft.draftId, [draft.declaredWeight]);
    this.store.transition(draft.draftId, { phase: 'ready' });
    return this.store.get(draft.draftId) ?? draft;
  }

  /**
   * Update an in-flight draft's claims/outputs in place. The draft
   * must be in a non-terminal, pre-solidify phase. No-op if the draft
   * is gone.
   */
  update(
    draftId: Hash,
    changes: { claims?: ClaimRef[]; outputs?: Output[]; refs?: Hash[] },
  ): Draft {
    return this.store.update(draftId, changes);
  }

  /**
   * Register a generator handle for a draft created via `create` so that
   * `detachDraft` / `cancel` can run the generator's cleanup (release
   * OutputClaimService entries, drain pre-queues, etc) when the draft
   * is later torn down. Producers that drive their own work via `create`
   * (e.g. GenerationService.enqueueGeneration) call this immediately
   * after starting the generation; the legacy `createDraft` path wires
   * the handle internally.
   */
  attachGeneratorHandle(draftId: Hash, handle: GeneratorHandle): void {
    this.handles.set(draftId.toPrimitive(), handle);
  }

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

  /**
   * Drafts available for merging into a solidifying batch: anything in
   * `ready` (caller could choose to solidify it) or `solidifying` (caller
   * already chose to but it hasn't landed yet -- still locks its claims
   * and outputs).
   */
  getReadyOrSolidifying(): Draft[] {
    return [
      ...this.store.getByPhase('ready'),
      ...this.store.getByPhase('solidifying'),
    ];
  }

  /**
   * Synchronously attempt to turn `seedDrafts` into a single block.
   *
   * Pre: every input draft is in `ready` or `solidifying`. Drafts in
   * `ready` transition to `solidifying` immediately.
   *
   * On `ok`: consumed drafts transition to `solidified` carrying the
   * produced block, are detached from consensus, and the block is
   * dispatched via the configured `processBlock` callback.
   *
   * On `awaitingAnchor` or hard failure: drafts STAY in `solidifying`.
   * Only `cancelDraft` can move a draft to `cancelled`. The retry loop
   * (canonicality-change subscription) is responsible for re-attempting.
   *
   * `solidify` is intended to be called at most once per draft as a
   * user action; subsequent retries are driven internally.
   */
  solidify(seedDrafts: Draft[]): SolidifyResult {
    if (!this._blockBuilder) {
      return { ok: false, reason: 'DraftManager not configured with a BlockBuilderModule' };
    }
    if (seedDrafts.length === 0) {
      return { ok: false, reason: 'no seed drafts' };
    }

    this._solidifyDepth++;
    try {
      // 1. Transition any non-`solidifying` seeds into `solidifying`.
      for (const seed of seedDrafts) {
        const phase = seed.status.phase;
        if (phase === 'solidifying') continue;
        if (phase === 'ready') {
          this.store.transition(seed.draftId, { phase: 'solidifying' });
          continue;
        }
        return {
          ok: false,
          reason: `draft ${seed.draftId.toHex().slice(0, 10)} is not solidifiable (phase ${phase})`,
        };
      }

      // 2. Compute re-solidify opts (aggregated witnesses + excluded
      // prior blocks) for each seed. For multi-draft batches we merge
      // the per-draft opts. Single-draft is the common case today.
      const resolidifyOpts = this._mergeResolidifyOpts(
        seedDrafts.map((d) => this._computeResolidifyOpts(d)),
      );

      // 3. Delegate to BlockBuilderModule. Pool is empty for now; step 8
      // of the consolidation refactor wires in autobalance via the pool.
      const result = this._blockBuilder.solidify(seedDrafts, [], resolidifyOpts);
      if (!result.ok) return result;

      // 4. Success: append the new block to each draft's solidifiedBlocks
      // history, transition to `solidified`, detach from consensus, then
      // dispatch the block. Detach BEFORE dispatch so the draft's phantom
      // claims clear out before the real block (which claims the same
      // outputs) is evaluated.
      const block = result.block;
      const consumedDraftIds = seedDrafts.map((d) => d.draftId);
      for (const id of consumedDraftIds) {
        this.detachDraft(id);
        this.store.appendSolidifiedBlock(id, block);
        this.store.transition(id, { phase: 'solidified' });
      }
      this._processBlock?.(block);

      return { ok: true, block, consumedDraftIds };
    } finally {
      this._solidifyDepth--;
    }
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
    // cancelled-status historical entry.
    this.consensus.removeBlock(draftId);

    // Transition to cancelled -- the draft persists in the store with
    // its terminal status so we don't relaunch the generator and so
    // debug tools can see why this draft ended.
    const draft = this.store.get(draftId);
    if (draft && !isDraftTerminal(draft.status)) {
      this.store.transition(draftId, {
        phase: 'cancelled',
        reason,
      });
    }
  }
}
