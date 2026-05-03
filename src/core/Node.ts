// Protocol spec: docs/protocol/dag.md (graph topology), docs/protocol/draft-blocks.md (drafts)
//
// Node is the unified graph-vertex surface that both Block and Draft satisfy.
// ConsensusModule, OutputClaimModule, weight propagation, and UtxoIndex
// consume blocks and drafts uniformly through this interface, with no
// special-casing for "real block vs in-flight draft".
//
// This file introduces the types only. Block and BlockDraft are migrated to
// satisfy `Node` in follow-up steps; consumer call sites are migrated off the
// legacy fields one by one. Nothing in this file changes existing behavior.

import { Hash } from '../util/Hash.ts';
import type { Output } from './BlockCreationModule.ts';
import type { BlockStore, Block } from './Block.ts';

// -- ClaimRef -------------------------------------------------------------
//
// Direct reference to a produced output. Hash-keyed (not object-keyed) so
// that two claims conflict structurally even when the producer hasn't been
// received yet: B and C both carrying `{ producer: A.hash, outputIndex: 0 }`
// compare equal regardless of whether A is in the local store.
//
// For blocks, `outputIndex` may initially refer to a position in the
// producer's *extended vector* (own outputs + aggregate + anchor's
// surviving outputs). OutputClaimModule.tryMigrate rewrites these in place
// as ancestors become canonical, replacing `producer` with the deeper block
// and `outputIndex` with the corresponding index in *that* block's extended
// vector, until eventually the index lands in the producer's own `outputs`
// array. At that point the claim is fully resolved.
//
// For drafts, claims are always created fully resolved -- the generator
// only runs when its inputs are present in the local store, so we always
// know the concrete `(producer, outputIndex)` at draft-creation time.
// Migration is a blocks-only concern.

export interface ClaimRef {
  /** Hash of the producing block. */
  readonly producer: Hash;
  /**
   * Index into the producer's extended vector when partially resolved, or
   * into the producer's own `outputs` array when fully resolved. See
   * `isFullyResolved`.
   */
  readonly outputIndex: number;
}

/** Structural equality. Two claims are equal iff they target the same slot. */
export function claimRefEquals(a: ClaimRef, b: ClaimRef): boolean {
  return a.outputIndex === b.outputIndex && Hash.equals(a.producer, b.producer);
}

/**
 * Resolution state of a claim.
 *
 *   `resolved`   -- index lands in the producer's own `outputs` array.
 *                   The claim points directly at a concrete output.
 *   `unresolved` -- producer is present but index is in the extended-vector
 *                   region (aggregate or anchor outputs). Still needs
 *                   migration.
 *   `unknown`    -- producer is not in the store yet; we cannot tell.
 *
 * Drafts are always `resolved` (invariant). Blocks may be in any state.
 */
export type ClaimResolution = 'resolved' | 'unresolved' | 'unknown';

export function classifyClaim(c: ClaimRef, store: BlockStore): ClaimResolution {
  const block = store.get(c.producer);
  if (!block) return 'unknown';
  return c.outputIndex < block.outputs.length ? 'resolved' : 'unresolved';
}

/** Convenience: true iff `classifyClaim(c, store) === 'resolved'`. */
export function isFullyResolved(c: ClaimRef, store: BlockStore): boolean {
  return classifyClaim(c, store) === 'resolved';
}

// -- Node -----------------------------------------------------------------
//
// The minimal surface that consensus, weight, and claim-resolution code
// depend on. Both Block and Draft satisfy this in subsequent migration
// steps; nothing else does.
//
// Identity is JS object equality. Two `Node` references compare equal iff
// they are the same JS object, which is 1:1 with block-hash for blocks and
// with draft-id for drafts. Nodes are never duplicated -- there is exactly
// one Node object per logical entity.

export type NodeKind = 'block' | 'draft';

export interface Node {
  readonly kind: NodeKind;

  /**
   * Outputs this Node produces. For blocks, never mutated after
   * construction. For drafts, populated incrementally by the generator
   * (via requireOutput / collectOutputs); append-only during the draft's
   * `generating` / `awaitingInput` phases, frozen once the draft
   * transitions to `readyToSolidify`. Typed as a plain array (rather than
   * ReadonlyArray) so Block can satisfy this interface alongside
   * BlockPayload, which uses Output[].
   */
  readonly outputs: Output[];

  /**
   * Outputs this Node spends, as direct `{ producer, outputIndex }` refs.
   * Blocks may carry partially-resolved entries (index into producer's
   * extended vector); drafts are always fully resolved (index into
   * producer's own `outputs`). ConsensusModule and UtxoIndex read this
   * directly -- there is no separate "reservation" set for drafts.
   *
   * Mutable so OutputClaimModule.tryMigrate can rewrite block claim entries
   * in place as ancestors become canonical, and so draft generators can
   * append claims via requireInput.
   */
  readonly claims: ClaimRef[];

  /**
   * Live, sampled weight used by ConsensusModule to pick the canonical
   * subgraph.
   *
   *   blocks -- declared weight + sub-tree sampled weight (per
   *             docs/protocol/weight.md).
   *   drafts -- grows monotonically while the generator runs (today,
   *             implementation-defined; planned: wall-clock based with a
   *             ~1s tick that re-evaluates canonicality).
   *
   * Both kinds compete on the same scale, so a long-running draft can
   * preempt a short-running one and a confirmed block can preempt either.
   */
  readonly effectiveWeight: number;
}

// -- Draft ----------------------------------------------------------------
//
// A draft is a planned-but-unhashed Node. It holds reservations atomically
// (its claims are already in the Node graph and visible to UtxoIndex), and
// lazily owns a generator that exercises those reservations.
//
// Drafts never produce drafts: even though a draft has `outputs`, those
// outputs are not entered into the "needs to be claimed" pool until the
// draft solidifies into a block. This keeps the producer of every ClaimRef
// in any other Node guaranteed to be a Block, which is what allows
// ClaimRef.producer to be a Hash (drafts have no hash).
//
// Drafts are never deleted. They progress through the states below;
// terminal states (`solidified`, `failed`) persist as historical record so
// we don't relaunch a generator we already know won't succeed, and so debug
// tools can answer "what happened to draft X?".

/** Stable, content-free identity for a draft. */
export type DraftId = Hash;

/** Reason a draft transitioned to `failed`, for debugging and not-to-relaunch. */
export type DraftFailureSite =
  | 'requireSignature'
  | 'requireInput'
  | 'contract'
  | 'lowering';

export type DraftStatus =
  /** Reservation in place; generator not yet started. */
  | { phase: 'pending' }
  /** Generator pumping. */
  | { phase: 'generating' }
  /** Generator paused awaiting an input value. */
  | { phase: 'awaitingInput'; key: { contract: Hash; params: Uint8Array } }
  /**
   * Generator finished; BlockBuilder has not yet been able to find an
   * anchor whose extended output space covers all draft claims. Re-tried
   * by BlockBuilderService when a new aggregation block becomes canonical.
   */
  | { phase: 'awaitingAnchor' }
  /** Generator complete, ready for BlockBuilder.build. */
  | { phase: 'readyToSolidify' }
  /** Lost canonicality; generator suspended; will resume if canonicality returns. */
  | { phase: 'paused'; reason: 'lostCanonicality' }
  /** Replaced by a real block. Terminal; preserved for history. */
  | { phase: 'solidified'; block: Block }
  /** Hard failure; do not relaunch. Terminal; preserved for history. */
  | { phase: 'failed'; reason: string; at: DraftFailureSite };

/** Terminal status check (`solidified` or `failed`). */
export function isDraftTerminal(s: DraftStatus): boolean {
  return s.phase === 'solidified' || s.phase === 'failed';
}

export interface Draft extends Node {
  readonly kind: 'draft';
  readonly id: DraftId;

  /**
   * Mutable during drafting: the generator may append claims via
   * requireInput / collectInputs. Frozen once the draft reaches a terminal
   * status. Always fully resolved (per the draft invariant).
   */
  readonly claims: ClaimRef[];

  /**
   * Mutable during generation: the generator emits outputs via
   * requireOutput / collectOutputs. Frozen once the draft reaches
   * `readyToSolidify` and beyond.
   */
  readonly outputs: Output[];

  status: DraftStatus;
}

// -- Helpers --------------------------------------------------------------

/** Predicate: a Node is a Block. Cheap discriminator. */
export function isBlock(n: Node): n is Node & { kind: 'block' } {
  return n.kind === 'block';
}

/** Predicate: a Node is a Draft. Cheap discriminator. */
export function isDraft(n: Node): n is Draft {
  return n.kind === 'draft';
}
