// Design spec: docs/design/trust-gate.md
// Protocol spec: docs/protocol/collateral-resolution.md (verdict record output)
//
// CollateralResolutionIndex -- tracks, for each target block H, the set of
// resolution sources (blocks or local drafts) that have declared a verdict
// on H via the collateral contract's verdict record output
// (`readVerdictFromBlock`).
//
// A source contributes a verdict iff:
//   - it is canonical, AND
//   - for blocks: verification has `passed`.
//     For drafts: the draft is in status `'ready'`.
//
// Verdict semantics: `invalid` beats `valid` among sources. "No contributor"
// reports `'none'`.
//
// This index is DI-agnostic; see CollateralResolutionIndexService for wiring.

import type { Hash, HashPrimitive } from '../util/Hash.ts';
import { readVerdictFromBlock, type CollateralVerdict } from '../contracts/CollateralContract.ts';
import type { Block } from '../core/Block.ts';
import type { BlockDraft } from '../core/BlockDraft.ts';

// -- Types ------------------------------------------------------------

export type VerdictQuery = 'valid' | 'invalid' | 'none';

export type VerificationStatus = 'unknown' | 'verifying' | 'passed' | 'failed';

export interface SourceRef {
  readonly kind: 'block' | 'draft';
  readonly hash: Hash;
}

interface Entry {
  readonly source: SourceRef;
  readonly target: Hash;
  readonly verdict: CollateralVerdict;
}

export interface CollateralResolutionIndexProvider {
  /** Enumerate all known blocks (used at construction for bootstrap). */
  iterateBlocks(): Iterable<Block>;
  /** Enumerate all ready drafts (used at construction for bootstrap). */
  iterateReadyDrafts(): Iterable<BlockDraft>;

  /** Subscribe to new-block insertions. Called once per freshly-added block. */
  onBlockAdded(cb: (block: Block) => void): () => void;
  /** Subscribe to draft status transitions (ready / cancelled). */
  onDraftTransition(cb: (draft: BlockDraft) => void): () => void;

  /** Synchronous verification status for a block hash. */
  getVerificationStatus(h: Hash): VerificationStatus;
  /** Verification status transitions on blocks. */
  onVerificationStatusChanged(
    cb: (h: Hash, status: VerificationStatus) => void,
  ): () => void;

  /** Whether a given hash (block or draft) is currently canonical. */
  isCanonical(h: Hash): boolean;
  /** Canonicality flips for any hash (blocks + drafts). */
  onCanonicalityChanged(cb: (h: Hash, canonical: boolean) => void): () => void;

  /**
   * Optional sink for malformed verdict outputs. A source that has a
   * verdict record output but fails to decode is dropped from the index
   * (a malformed verdict carries no signal). The hook lets the wiring
   * layer log it via whatever logging facility it has.
   */
  onMalformedVerdict?(source: SourceRef, err: unknown): void;
}

// -- Implementation ---------------------------------------------------

/**
 * Tracks verdict outputs from canonical, verified resolution sources.
 *
 * Entries go through two states:
 *   - pending: we saw the verdict output but the source isn't eligible
 *     yet (block still verifying, or draft not in `'ready'`). Held off
 *     the active map.
 *   - active: source is eligible; entry contributes to `verdict(target)`.
 *
 * A source becomes eligible once:
 *   - block: `getVerificationStatus === 'passed'`, OR
 *   - draft: status === `'ready'`.
 *
 * Canonicality is filtered at query time -- the active map may contain
 * non-canonical entries; `verdict(h)` skips them via `isCanonical`.
 */
export class CollateralResolutionIndex {
  /** Sources whose verdict output we've seen but are not yet eligible. */
  private readonly _pending = new Map<HashPrimitive, Entry>();
  /** Eligible sources, grouped by target hash. */
  private readonly _active = new Map<HashPrimitive, Entry[]>();
  /** Target Hash a given source contributes to (for retraction / canonicality fan-out). */
  private readonly _sourceTargets = new Map<HashPrimitive, Hash>();

  private readonly _verdictListeners: ((h: Hash, v: VerdictQuery) => void)[] = [];
  /** Cached last-fired verdict per target, to dedupe events. */
  private readonly _lastVerdict = new Map<HashPrimitive, VerdictQuery>();

  constructor(private readonly provider: CollateralResolutionIndexProvider) {
    // Bootstrap: scan existing blocks and drafts.
    for (const block of provider.iterateBlocks()) {
      this._ingestBlock(block);
    }
    for (const draft of provider.iterateReadyDrafts()) {
      this._ingestDraft(draft);
    }

    provider.onBlockAdded((block) => this._ingestBlock(block));
    provider.onDraftTransition((draft) => this._onDraftTransition(draft));
    provider.onVerificationStatusChanged((h, s) =>
      this._onVerificationChanged(h, s),
    );
    provider.onCanonicalityChanged((h, canonical) =>
      this._onCanonicalityChanged(h, canonical),
    );
  }

  /** Best verdict for target H among all currently-eligible canonical sources. */
  verdict(target: Hash): VerdictQuery {
    const list = this._active.get(target.toPrimitive());
    if (!list || list.length === 0) return 'none';
    let sawValid = false;
    for (const e of list) {
      if (!this.provider.isCanonical(e.source.hash)) continue;
      if (e.verdict === 'invalid') return 'invalid';
      if (e.verdict === 'valid') sawValid = true;
    }
    return sawValid ? 'valid' : 'none';
  }

  /** Fires only when the resolved verdict for a target actually changes. */
  onVerdictChanged(cb: (h: Hash, v: VerdictQuery) => void): () => void {
    this._verdictListeners.push(cb);
    return () => {
      const i = this._verdictListeners.indexOf(cb);
      if (i >= 0) this._verdictListeners.splice(i, 1);
    };
  }

  // -- Ingestion --------------------------------------------------

  private _ingestBlock(block: Block): void {
    const source: SourceRef = { kind: 'block', hash: block.hash };
    const v = this._readVerdict(block, source);
    if (!v) return;
    const entry: Entry = { source, target: v.target, verdict: v.verdict };
    const status = this.provider.getVerificationStatus(block.hash);
    if (status === 'passed') {
      this._activate(entry);
    } else if (status === 'failed') {
      // Failed sources never contribute.
      return;
    } else {
      this._pending.set(block.hash.toPrimitive(), entry);
    }
  }

  private _ingestDraft(draft: BlockDraft): void {
    const source: SourceRef = { kind: 'draft', hash: draft.draftId };
    const v = this._readVerdict(draft, source);
    if (!v) return;
    const entry: Entry = { source, target: v.target, verdict: v.verdict };
    // Drafts don't participate in block verification -- treat status==='ready'
    // as the activation gate. `_onDraftTransition` routes non-ready drafts.
    if (draft.status === 'ready') {
      this._activate(entry);
    }
  }

  private _readVerdict(
    block: { outputs: Block['outputs'] },
    source: SourceRef,
  ): ReturnType<typeof readVerdictFromBlock> {
    try {
      return readVerdictFromBlock(block);
    } catch (err) {
      this.provider.onMalformedVerdict?.(source, err);
      return undefined;
    }
  }

  // -- Event handlers ---------------------------------------------

  private _onVerificationChanged(h: Hash, status: VerificationStatus): void {
    const key = h.toPrimitive();
    const pending = this._pending.get(key);
    if (!pending) return;
    if (status === 'passed') {
      this._pending.delete(key);
      this._activate(pending);
    } else if (status === 'failed') {
      this._pending.delete(key);
    }
  }

  private _onDraftTransition(draft: BlockDraft): void {
    const key = draft.draftId.toPrimitive();
    if (draft.status === 'ready') {
      // Promote if we haven't already recorded it.
      if (!this._sourceTargets.has(key) && !this._pending.has(key)) {
        this._ingestDraft(draft);
      }
    } else if (draft.status === 'cancelled') {
      this._retractSource(draft.draftId);
    }
  }

  private _onCanonicalityChanged(h: Hash, _canonical: boolean): void {
    // We filter canonicality at query time, so any source that
    // contributes to some target must re-fire that target's listeners.
    const target = this._sourceTargets.get(h.toPrimitive());
    if (!target) return;
    this._fireIfChanged(target);
  }

  // -- Mutations --------------------------------------------------

  private _activate(entry: Entry): void {
    const targetKey = entry.target.toPrimitive();
    const list = this._active.get(targetKey) ?? [];
    list.push(entry);
    this._active.set(targetKey, list);
    this._sourceTargets.set(entry.source.hash.toPrimitive(), entry.target);
    this._fireIfChanged(entry.target);
  }

  private _retractSource(sourceHash: Hash): void {
    const srcKey = sourceHash.toPrimitive();
    this._pending.delete(srcKey);
    const target = this._sourceTargets.get(srcKey);
    if (!target) return;
    this._sourceTargets.delete(srcKey);
    const targetKey = target.toPrimitive();
    const list = this._active.get(targetKey);
    if (!list) return;
    const remaining = list.filter(
      (e) => e.source.hash.toPrimitive() !== srcKey,
    );
    if (remaining.length === 0) {
      this._active.delete(targetKey);
    } else {
      this._active.set(targetKey, remaining);
    }
    this._fireIfChanged(target);
  }

  private _fireIfChanged(target: Hash): void {
    const key = target.toPrimitive();
    const current = this.verdict(target);
    const prev = this._lastVerdict.get(key) ?? 'none';
    if (current === prev) return;
    this._lastVerdict.set(key, current);
    for (const cb of this._verdictListeners) cb(target, current);
  }
}
