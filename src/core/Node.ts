// Protocol spec: docs/protocol/dag.md (graph topology), docs/protocol/draft-blocks.md (drafts)
//
// Node is the unified graph-vertex surface that both Block and Draft satisfy.
// ConsensusModule, OutputClaimModule, weight propagation, and UtxoIndex
// consume blocks and drafts uniformly through this interface, with no
// special-casing for "real block vs in-flight draft".
//
// This file introduces the Node + ClaimRef types only. Block and Draft are migrated to
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
   * (via emitOutput / collectOutputs); append-only during the draft's
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
   * append claims via claimNext.
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

// -- Helpers --------------------------------------------------------------
//
// The concrete `Draft` type (the planned-but-unhashed Node with its own
// status field, factory, and store) lives in `./Draft.ts`. Keeping Node
// content-free of the draft lifecycle keeps this file's surface narrow:
// just the graph-vertex contract that ConsensusModule, OutputClaimModule,
// and weight propagation depend on.

/** Predicate: a Node is a Block. Cheap discriminator. */
export function isBlock(n: Node): n is Node & { kind: 'block' } {
  return n.kind === 'block';
}

/** Predicate: a Node is a Draft. Cheap discriminator. */
export function isDraft(n: Node): n is Node & { kind: 'draft' } {
  return n.kind === 'draft';
}
