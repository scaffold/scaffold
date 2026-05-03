// Shared anchor-selection logic. Used by:
//   - BlockBuilderModule.build (solidifying a draft into a block)
//   - ConsensusService (computing a draft's anchor + aggregates for weight
//     attribution -- drafts contribute weight through the same anchor chain
//     they will solidify against)
//
// The two callsites must agree, otherwise a draft's pre-solidification
// weight contribution lands on a different chain than the eventual block,
// which would cause weight to spuriously appear/disappear when the draft
// solidifies.
//
// Algorithm: deepest common ancestor of all `producers` in their anchor
// chains. Producers that aren't the chosen anchor itself become aggregate
// references. For the case where producers themselves share a single
// anchor (e.g. B and C both anchor to A) the result is `{ anchor: A,
// aggregates: [B, C] }` -- identical to a real aggregator block over B + C.

import type { Hash } from '../util/Hash.ts';
import { Hash as HashCtor } from '../util/Hash.ts';
import type { Block, BlockStore } from './Block.ts';

export type AnchorSelection =
  /** Common ancestor found. */
  | { ok: true; anchor: Hash; aggregates: Hash[] }
  /**
   * No producer set has a common ancestor in the store yet -- callers that
   * want to defer (BlockBuilder = "park draft until aggregation lands";
   * ConsensusService = "draft has no anchor, treat as uncanonical") use
   * `missing` to know which producers are unreachable.
   */
  | { ok: false; missing: Hash[] };

/**
 * Pick the anchor + aggregate set covering all `producers`.
 *
 * If `producers.length === 1`, the single producer is the anchor (no
 * aggregates needed). For larger sets we walk each producer's anchor
 * chain and pick the common ancestor with smallest max-depth across
 * producers (closest to all of them). The non-anchor producers become
 * aggregates.
 */
export function pickAnchor(
  producers: ReadonlyArray<Hash>,
  store: BlockStore,
): AnchorSelection {
  if (producers.length === 0) {
    return { ok: false, missing: [] };
  }

  // Walk each producer's anchor chain, recording presence + depth.
  const chains: Map<string, number>[] = [];
  for (const p of producers) {
    const m = new Map<string, number>();
    let cur: Hash | undefined = p;
    let depth = 0;
    while (cur && store.has(cur)) {
      m.set(cur.toPrimitive(), depth);
      const b: Block = store.get(cur)!;
      cur = b.anchor;
      depth++;
    }
    chains.push(m);
  }

  // Find common ancestors and pick the one whose max depth across all
  // producers is minimal.
  let best: Hash | undefined;
  let bestMaxDepth = Infinity;
  for (const candidateKey of chains[0].keys()) {
    if (!chains.every((m) => m.has(candidateKey))) continue;
    const maxDepth = Math.max(...chains.map((m) => m.get(candidateKey)!));
    if (maxDepth < bestMaxDepth) {
      bestMaxDepth = maxDepth;
      best = HashCtor.fromPrimitive(candidateKey);
    }
  }

  if (!best) {
    return { ok: false, missing: producers.slice() };
  }

  // Producers that aren't the anchor itself become aggregate references.
  const anchorKey = best.toPrimitive();
  const aggregates = producers.filter((p) => p.toPrimitive() !== anchorKey);
  return { ok: true, anchor: best, aggregates };
}

/** Convenience: pick anchor + aggregates from claim refs (deduped by producer). */
export function pickAnchorForClaims(
  claims: ReadonlyArray<{ readonly producer: Hash }>,
  store: BlockStore,
): AnchorSelection {
  const seen = new Set<string>();
  const producers: Hash[] = [];
  for (const c of claims) {
    const key = c.producer.toPrimitive();
    if (seen.has(key)) continue;
    seen.add(key);
    producers.push(c.producer);
  }
  return pickAnchor(producers, store);
}
