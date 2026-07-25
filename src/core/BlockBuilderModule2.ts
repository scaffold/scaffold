import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { error, todo } from '../util/functional.ts';
import { BlockStore } from './BlockStore.ts';
import {
  PlacementNode,
  PlacementRequest,
  PlacementResult,
  PlacementService,
} from './PlacementModule2.ts';
import { AGGREGATION_CONTRACT, AtomType, BlockPayload, Draft } from './types.ts';

export type BuildResult =
  | { ok: true; payload: BlockPayload }
  /**
   * No anchor reaches everything the draft claims. `pendingAggregation` are the
   * tree roots an aggregation must merge before the draft can solidify (wp 4.2).
   * The draft is parked; `draft.currentBuild.cancel()` abandons it.
   */
  | { ok: false; pendingAggregation: PlacementNode[] };

export abstract class BlockBuilderModule {
  protected abstract place(request: PlacementRequest): PlacementResult;
  protected abstract getBlock(hash: Hash): PlacementNode;

  build(draft: Draft): BuildResult {
    if (draft.currentBuild !== undefined) {
      draft.currentBuild.cancel();
      draft.currentBuild = undefined;
    }

    // -- 1. Anchor selection (wp 4.2) ----------------------------------
    // Pick an anchor whose reach -- its own tree plus the trees of everything
    // on its anchor chain -- covers every block this draft claims or refs, and
    // the anchor of every block it aggregates. Excluded blocks are rivals that
    // already claim an output we want; anchoring inside their reach would order
    // them ahead of us and disqualify our claim (wp 4.4, 5.3). If nothing
    // covers the draft yet it can't solidify: park it, and retry when an
    // aggregation merging the reported tips lands.
    const placement = this.place({
      includes: [...draft.claims, ...draft.refs].map((c) => this.getBlock(c.producer)),
      aggregates: this.aggregatedBlocks(draft),
      excludes: this.rivalClaimants(draft),
    });
    if (!placement.ok) {
      draft.currentBuild = {
        status: 'pending_aggregation',
        cancel: () => {
          draft.currentBuild = undefined;
        },
      };
      return { ok: false, pendingAggregation: placement.tips };
    }
    const anchor = placement.anchor;

    // -- 2. Aggregation set (wp 4.3, 7) --------------------------------
    // The set itself is already decided -- wp 7 makes `aggregates` a restatement
    // of the claims, one entry per claimed aggregation output. What remains is
    // per-entry `outputCount` (the aggregated block's own output count plus the
    // sum of its aggregates' outputCounts) and ordering the array
    // heaviest-descendant-weight first (misordering is a soft penalty, 5.3).

    // -- 3. Chain vector (wp 4.2) --------------------------------------
    // Fill `chain[i] = {weight, throughput}` per anchor-chain position:
    // weight = descendant work attributed to entry i (each subtree block's work
    // walks up its OWN anchor chain until it first meets a block on this block's
    // anchor chain); throughput = coins this block claims out of entry i's tree.
    // Positions past the array end are implicitly {0, 0}.

    // -- 4. Claims and refs -> indices (wp 4.5, 4.7) -------------------
    // Lower each draft claim (producer, outputIndex) into a global-output-space
    // index relative to this block (more recent outputs have lower indices).
    // Refs lower the same way but may target any output, claimed or not (4.7).

    // -- 5. Outputs and conservation (wp 5.1, 5.2) ---------------------
    // Assemble `outputs` from the draft's produced outputs, the aggregation-fee
    // output (itself just an output to the aggregation contract, 7), and any
    // change. Enforce block-local conservation: sum(output amounts) ==
    // sum(claimed output amounts).

    // -- 6. Merkle claimed/unclaimed mask (wp 4.6) ---------------------
    // When aggregating, build the claimed/unclaimed bitvector over the extended
    // output space and store its merkle root in the aggregation output's data.
    // Light clients never touch it; only aggregators/probers maintain it.

    // -- 7. Timestamp (wp 4.1, 9.7) ------------------------------------
    // Set `timestampMs` >= the max timestamp of the anchor and all aggregated
    // blocks, and to roughly now. Future-dating just leaves the block weightless
    // until its time (9.7); back-dating is floored by anchor/aggregate times.

    // -- 8. Return the unsigned BlockPayload ---------------------------
    return todo(`BlockBuilder steps 2-8, anchored at ${anchor.hash.toHex()}`);
  }

  /**
   * The blocks this draft rolls up. wp 7 makes the aggregates array a
   * restatement of the claims -- a block aggregates exactly the producers of
   * the aggregation outputs it claims -- so the set is read off, never chosen.
   * Deciding to aggregate is an economic act (probing, insurance, the balance
   * rule) and belongs to whoever assembled the draft's claims.
   */
  private aggregatedBlocks(draft: Draft): PlacementNode[] {
    const found = new Map<HashPrimitive, PlacementNode>();
    for (const claim of draft.claims) {
      const producer = this.getBlock(claim.producer);
      if (producer.type !== AtomType.Block) {
        // Without the payload we cannot tell an aggregation claim from any
        // other, and guessing would anchor the block in the wrong place.
        return error(`build: claimed producer ${producer.hash.toHex()} is unresolved`);
      }
      const output = producer.payload.outputs[Number(claim.outputIndex)];
      if (output === undefined) {
        return error(
          `build: claim on ${producer.hash.toHex()} output ${claim.outputIndex} is out of range`,
        );
      }
      if (!Hash.equals(output.contractHash, AGGREGATION_CONTRACT)) continue;
      found.set(producer.hash.toPrimitive(), producer);
    }
    return [...found.values()];
  }

  /**
   * Published blocks that already claim an output this draft wants. Drafts are
   * skipped -- an unpublished claim orders nowhere and cannot beat us.
   */
  private rivalClaimants(draft: Draft): PlacementNode[] {
    const found = new Map<HashPrimitive, PlacementNode>();
    for (const claim of draft.claims) {
      const producer = this.getBlock(claim.producer);
      for (const rival of producer.resolvingOutputs.get(claim.outputIndex) ?? []) {
        const claimer = rival.claimer;
        if (claimer.type !== AtomType.Block) continue;
        found.set(claimer.hash.toPrimitive(), claimer);
      }
    }
    return [...found.values()];
  }
}

export class BlockBuilderService extends BlockBuilderModule {
  constructor(private ctx: Context) {
    super();
  }

  protected override place(request: PlacementRequest): PlacementResult {
    return this.ctx.get(PlacementService).place(request);
  }

  protected override getBlock(hash: Hash): PlacementNode {
    return this.ctx.get(BlockStore).get(hash);
  }
}
