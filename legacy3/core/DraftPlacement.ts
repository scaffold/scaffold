// Shared helper for deriving a draft's anchor via placement. Used by:
//   - BlockBuilderModule.build (solidification)
//   - ConsensusService (pre-solidification draft anchor for weight)
//   - NodeWeightsService (draft anchor for weight propagation)
//
// All three callers must agree on a draft's anchor; otherwise a draft's
// pre-solidification weight contribution lands on a different chain than
// the eventual block, and weight spuriously appears/disappears at
// solidification. This helper centralises the call so they stay in sync.

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { AGGREGATION_CONTRACT, Block, BlockStore } from './Block.ts';
import { Draft } from './Draft.ts';
import { PlacementModule, PlacementResult } from './PlacementModule.ts';

/** Dedupe a draft's claim producers, preserving first-seen order. */
export function dedupeProducers(
  claims: ReadonlyArray<{ readonly producer: Hash }>,
): Hash[] {
  const seen = new Set<HashPrimitive>();
  const producers: Hash[] = [];
  for (const c of claims) {
    const key = c.producer.toPrimitive();
    if (seen.has(key)) continue;
    seen.add(key);
    producers.push(c.producer);
  }
  return producers;
}

/**
 * Detect aggregation include constraints implicit in the draft's marker
 * claims: each claim on an AGGREGATION_CONTRACT-produced output makes
 * its producer an aggregated block.
 *
 * This bridges the spec's "include constraints accumulated during
 * generation" (per aggregation.md) until Drafts gain an explicit
 * `aggregatedBlocks` field. Three callers depend on this returning the
 * same set: BlockBuilder (solidification), ConsensusService (draft
 * anchor for weight), and NodeWeightsService (draft anchor for weight
 * propagation).
 */
export function detectAggregatedBlocks(
  draft: Draft,
  store: BlockStore,
): Hash[] {
  const result: Hash[] = [];
  const seen = new Set<HashPrimitive>();
  for (const c of draft.claims) {
    const producer = store.get(c.producer);
    if (!producer) continue;
    const output = producer.outputs[c.outputIndex];
    if (!output) continue;
    if (!Hash.equals(output.verifier.contract, AGGREGATION_CONTRACT)) continue;
    const key = c.producer.toPrimitive();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c.producer);
  }
  return result;
}

/** Place a draft. Returns the placement result, or stalled if placement is not yet wired. */
export function placeDraft(
  draft: Draft,
  store: BlockStore,
  placement: PlacementModule<Block> | undefined,
): PlacementResult {
  if (!placement) return { ok: false, stalled: true };
  return placement.place({
    // Carry the draft so PlacementService can exclude it from any canonical-view
    // lookups during placement -- breaks the placement <-> consensus-weight cycle
    // (see PlacementService.place).
    node: draft,
    claimedBlocks: dedupeProducers(draft.claims),
    aggregatedBlocks: detectAggregatedBlocks(draft, store),
    // No caller produces excludes today. Future: collateral contracts.
    excludedBlocks: [],
  });
}

/**
 * Compute a draft's anchor for consensus / weight-propagation purposes.
 * Returns ZERO_HASH if placement is not wired or if the draft is stalled.
 */
export function draftAnchorViaPlacement(
  draft: Draft,
  store: BlockStore,
  placement: PlacementModule<Block> | undefined,
): Hash {
  const result = placeDraft(draft, store, placement);
  return result.ok ? result.anchor : ZERO_HASH;
}
