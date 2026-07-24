import { Context } from '../Context.ts';
import { todo } from '../util/functional.ts';
import { BlockPayload, Draft } from './types.ts';

export abstract class BlockBuilderModule {
  constructor() {}

  protected abstract getX(): number;
}

export class BlockBuilderService extends BlockBuilderModule {
  constructor(private ctx: Context) {}

  build(draft: Draft): BlockPayload {
    if (draft.currentBuild !== undefined) {
      draft.currentBuild.cancel();
      draft.currentBuild = undefined;
    }

    // -- 1. Anchor selection (wp §4.2) ---------------------------------
    // Pick an anchor: a canonical prior tree root strictly larger than this
    // block, whose anchor chain -- together with this block's aggregates --
    // includes every block the draft claims or refs. Following anchors gives
    // the size-increasing anchor chain, terminating at genesis. If no canonical
    // anchor yet covers all claim/ref producers, the draft can't solidify:
    // park it and retry when a bridging aggregation lands.

    // -- 2. Aggregation set (wp §4.3, §7) ------------------------------
    // Determine `aggregates`, the blocks this block aggregates. An aggregation
    // block claims >= 2 similarly-sized aggregation outputs, each aggregate
    // smaller than 60% of the aggregate (the balance rule, §7); no block twice.
    // Order heaviest-descendant-weight first (misordering is a soft penalty,
    // §5.3). For each, set `outputCount` = the aggregated block's own output
    // count plus the sum of that block's aggregates' outputCounts.

    // -- 3. Chain vector (wp §4.2) -------------------------------------
    // Fill `chain[i] = {weight, throughput}` per anchor-chain position:
    // weight = descendant work attributed to entry i (each subtree block's work
    // walks up its OWN anchor chain until it first meets a block on this block's
    // anchor chain); throughput = coins this block claims out of entry i's tree.
    // Positions past the array end are implicitly {0, 0}.

    // -- 4. Claims and refs -> indices (wp §4.5, §4.7) -----------------
    // Lower each draft claim (producer, outputIndex) into a global-output-space
    // index relative to this block (more recent outputs have lower indices).
    // Add one self-claim of every aggregate's aggregation output (§7). Refs
    // lower the same way but may target any output, claimed or not (§4.7).

    // -- 5. Outputs and conservation (wp §5.1, §5.2) -------------------
    // Assemble `outputs` from the draft's produced outputs, the aggregation-fee
    // output (itself just an output to the aggregation contract, §7), and any
    // change. Enforce block-local conservation: sum(output amounts) ==
    // sum(claimed output amounts).

    // -- 6. Merkle claimed/unclaimed mask (wp §4.6) --------------------
    // When aggregating, build the claimed/unclaimed bitvector over the extended
    // output space and store its merkle root in the aggregation output's data.
    // Light clients never touch it; only aggregators/probers maintain it.

    // -- 7. Timestamp (wp §4.1, §9.7) ----------------------------------
    // Set `timestampMs` >= the max timestamp of the anchor and all aggregated
    // blocks, and to roughly now. Future-dating just leaves the block weightless
    // until its time (§9.7); back-dating is floored by anchor/aggregate times.

    // -- 8. Return the unsigned BlockPayload ---------------------------
    return todo();
  }

  protected override getX() {
    return 0;
  }
}
