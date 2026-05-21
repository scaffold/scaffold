// Protocol spec: docs/protocol/block-creation.md
//
// BlockBuilderModule is the single place blocks come into existence.
// Both draft solidification and Scaffold.put go through here. It
// encapsulates anchor selection, claim-index lowering, self-claim
// insertion, aggregation output patching, value override, and signing.
//
// This subsumes most of the work that previously lived in
// `NodeContext._solidifyDraft`: that method becomes a thin caller that
// invokes `build(draft)` and routes the result.
//
// Aggregate-self (a draft promoting itself to an aggregate) is deferred
// to a later iteration; today the two viable outcomes from `build` are
// `ok: true` (block produced) and `ok: false; awaitingAnchor: true`
// (no anchor in the canonical store covers the draft's claims yet --
// caller parks until a new aggregation block lands).

import type { Hash } from '../util/Hash.ts';
import type { Block, BlockStore } from './Block.ts';
import { getBlockTotalWeightVector, RECORD_CONTRACT } from './Block.ts';
import { Hash as HashCtor, type HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import type { BlockSpec, ClaimEntry, Output } from './BlockCreationModule.ts';
import type { Draft } from './Draft.ts';
import { encodeAggregationData, getAggregationData } from '../contracts/AggregationContract.ts';
import { AGGREGATION_CONTRACT } from './Block.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from './OutputSpace.ts';
import type { OutputSlot } from './GeneratingEnv.ts';
import type { Verifier } from './BlockCreationModule.ts';
import { dedupeProducers, detectAggregatedBlocks } from './DraftPlacement.ts';
import { PlacementModule } from './PlacementModule.ts';

/**
 * Solidification-time value-override function. Called for every slot
 * whose origin is `'get'`. Returns the final `value` for that output
 * (must be `>= defaultValue` -- the partition check at verification
 * rejects lowered values). `verifier` and `data` are frozen at
 * generation time and are supplied here for context.
 */
export type ValueOverrideFn = (
  verifier: Verifier,
  body: Uint8Array,
  defaultValue: number,
) => number;

/** Outcome of attempting to build a block from a draft. */
export type BuildResult =
  /** Block produced and signed. Caller is responsible for processing it. */
  | { ok: true; block: Block }
  /**
   * No anchor in the canonical store covers all claim producers yet.
   * Caller should park the draft and re-attempt when a new aggregation
   * block lands. `missing` lists the producers we couldn't bridge.
   */
  | { ok: false; awaitingAnchor: true; missing: Hash[] }
  /** Hard failure (no claims, signing failed, etc.). Draft cannot be solidified. */
  | { ok: false; reason: string };

export interface BlockBuilderProvider {
  readonly store: BlockStore;
  /**
   * Placement for anchor selection. Optional during construction so
   * NodeContext can wire it after services finish initialising; if
   * unset at `build()` time, drafts stall.
   */
  placement: PlacementModule<Block> | null;
  /** Sign a BlockSpec into a Block. May return null on signing failure. */
  createBlock(spec: BlockSpec, privateKey: Uint8Array | null): Block | null;
  /** Optional value-override hook for `requestBody` slots. */
  valueOverride: ValueOverrideFn | null;
  /** Private key for signing, or null for unsigned blocks. */
  privateKey: Uint8Array | null;
  /**
   * Fallback anchor for drafts that have no claims and no aggregated
   * blocks (typically zero-value record puts). When unset, such drafts
   * stall at placement.
   */
  getDefaultAnchor?: () => Hash | undefined;
}

export class BlockBuilderModule {
  constructor(private readonly provider: BlockBuilderProvider) {}

  /**
   * Lower a draft into a block. Picks an anchor whose extended output
   * space covers all draft claims, computes claim indices, applies
   * self-claim insertion + aggregation patch + value override, and signs.
   *
   * Pre: draft.claims are all fully resolved (`outputIndex < producer.outputs.length`).
   *      The contract layer guarantees this -- by the time a generator
   *      transitions to `ready`, every ClaimRef points at a real
   *      `producer.outputs[outputIndex]`.
   *
   * Post (ok): a new Block exists. The caller (typically NodeContext)
   *            is responsible for processing it through the reactive
   *            layer.
   *
   * Post (awaitingAnchor): no producer set has a common ancestor in the
   *                        canonical store. Caller parks the draft until
   *                        an aggregation block bridges them.
   */
  build(
    draft: Draft,
    opts?: {
      /**
       * Extra aggregated blocks to union with the draft's own claim-derived
       * set. Used by the re-solidify retry loop to force a new attempt to
       * descend from canonical conflict witnesses on previous attempts'
       * losing branches.
       */
      aggregatedBlocks?: Hash[];
      /**
       * Blocks placement must NOT anchor at or descend from. Used by the
       * re-solidify retry loop to forbid re-anchoring at the draft's
       * previously-failed blocks (so each retry produces a fresh hash).
       */
      excludedBlocks?: Hash[];
    },
  ): BuildResult {
    // -- 1. Anchor selection: placement against the canonical view ------
    //
    // Aggregation include constraints: claims targeting AGGREGATION_CONTRACT
    // marker outputs convert their producers into aggregated blocks. This
    // mirrors the implicit semantic from `aggregation.md` -- claimNext()
    // on the aggregation contract adds the producing block as an include
    // constraint -- without yet plumbing constraints onto the Draft type.
    // Shared with ConsensusService / NodeWeightsService so all three
    // callers compute the same anchor for any given draft.
    const detectedAggregates = detectAggregatedBlocks(draft, this.provider.store);
    const aggregatedBlocks = dedupeHashes([
      ...detectedAggregates,
      ...(opts?.aggregatedBlocks ?? []),
    ]);
    const claimedBlocks = dedupeProducers(draft.claims);
    const excludedBlocks = opts?.excludedBlocks ?? [];

    let anchor: Hash;
    if (claimedBlocks.length === 0 && aggregatedBlocks.length === 0) {
      // Zero-claim, zero-aggregate drafts (e.g. record puts) have no
      // signal for placement to anchor against. Fall back to a default
      // anchor if the provider supplies one.
      const fallback = this.provider.getDefaultAnchor?.();
      if (!fallback) {
        return { ok: false, reason: 'draft has no claims and no default anchor' };
      }
      anchor = fallback;
    } else {
      const placement = this.provider.placement;
      const result = placement
        ? placement.place({
          node: draft,
          claimedBlocks,
          aggregatedBlocks,
          excludedBlocks,
        })
        : { ok: false as const, stalled: true as const };
      if (!result.ok) {
        // Placement stalled. Caller parks the draft and retries on
        // canonical-view changes. `missing` is the set of claim producers
        // -- a coarse but functional retry signal.
        return {
          ok: false,
          awaitingAnchor: true,
          missing: claimedBlocks,
        };
      }
      anchor = result.anchor;
    }
    // The block's `aggregates` field is exactly the include-constraint
    // set fed into placement. No filtering: chain aggregates (where one
    // aggregate's subtree includes another) are allowed -- aggregation.md
    // calls this the linear-aggregation case.
    const aggregates = aggregatedBlocks;

    // Build per-aggregate output counts and weight info from each
    // aggregate's cached aggregation data (or leaf defaults).
    //
    // Weight info is the AggregationContract's blind spot: the contract
    // sees only marker outputs, so leaf inputs (empty data) emit zero
    // weight contributions. Re-deriving here from store-resident block
    // state ensures `chainWeights` and `aggregateWeights` reflect the
    // leaves' actual `declaredWeight`, matching `BlockCreationModule.deriveWeightVector`.
    const aggregateOutputCounts: number[] = [];
    const aggregateWeights: number[] = [];
    const subtreeInfos: { anchorDepth: number; weightVector: number[] }[] = [];
    for (const aggHash of aggregates) {
      const aggBlock = this.provider.store.get(aggHash);
      if (!aggBlock) {
        aggregateOutputCounts.push(0);
        aggregateWeights.push(0);
        subtreeInfos.push({ anchorDepth: 0, weightVector: [] });
        continue;
      }
      const aggData = getAggregationData(aggBlock);
      const sc = aggBlock.claimIndices.filter((c) => c < aggBlock.outputs.length).length;
      aggregateOutputCounts.push(aggData?.newOutputCount ?? (aggBlock.outputs.length - sc));

      // Subtree weight contribution: the aggregate's full per-depth weight
      // (declaredWeight folded into entry 0) attributed at its anchor's
      // depth from this block's anchor. Match the dual-direction lookup
      // in BlockCreationModule.buildBlock so an aggregate anchored above
      // OR below `anchor` resolves correctly.
      const aggAnchor = aggBlock.anchor;
      const depth = anchorChainDepth(this.provider.store, anchor, aggAnchor) ??
        anchorChainDepth(this.provider.store, aggAnchor, anchor) ?? 0;
      const wv = getBlockTotalWeightVector(aggBlock);
      subtreeInfos.push({ anchorDepth: depth, weightVector: wv });
      // aggregateWeights[i]: total weight of aggregate i's subtree (own
      // declaredWeight + descendants). SamplingModule and TrustService
      // sum these as the block's per-aggregate weight contribution.
      aggregateWeights.push(wv.reduce((a, b) => a + b, 0));
    }
    // chainWeights[d]: combined subtree weight at this block's anchor
    // chain depth d. Excludes this block's own `declaredWeight`
    // (consumers fold that in via getBlockTotalWeightVector).
    const chainWeights = composeChainWeights(subtreeInfos);

    // -- 3. Self-claims (RECORD outputs) -----------------------------
    //
    // Records are atomically produced+consumed on the emitting block.
    // Downstream assembly handles the claim bookkeeping here, keeping
    // it out of contract code. See computation.md#self-claimed-outputs.
    const selfClaimedIndices: number[] = [];
    for (let i = 0; i < draft.outputs.length; i++) {
      if (HashCtor.equals(draft.outputs[i].verifier.contract, RECORD_CONTRACT)) {
        selfClaimedIndices.push(i);
      }
    }
    const selfClaimCount = selfClaimedIndices.length;

    // -- 4. Virtual OutputSpaceBlock + provider ----------------------
    //
    // We need OutputSpaceModule to compute claim indices for a block
    // that doesn't exist in the store yet. Synthesize a virtual entry
    // for the draft and wrap the real store provider.
    const virtualHash = draft.draftId;
    const virtualBlock: OutputSpaceBlock = {
      hash: virtualHash,
      anchor,
      aggregates,
      outputs: draft.outputs.map((o) => ({ value: o.value })),
      claimIndices: [...selfClaimedIndices].sort((a, b) => a - b),
      aggregateOutputCounts,
      newOutputCount: draft.outputs.length - selfClaimCount +
        aggregateOutputCounts.reduce((a, b) => a + b, 0),
    };
    const store = this.provider.store;
    const virtualProvider: OutputSpaceProvider = {
      getBlock(hash: Hash): OutputSpaceBlock | undefined {
        if (HashCtor.equals(hash, virtualHash)) return virtualBlock;
        const block = store.get(hash);
        if (!block) return undefined;
        const aggData = getAggregationData(block);
        const sc = block.claimIndices.filter((c) => c < block.outputs.length).length;
        return {
          hash: block.hash,
          anchor: block.anchor,
          aggregates: block.aggregates,
          outputs: block.outputs.map((o) => ({ value: o.value })),
          claimIndices: [...block.claimIndices].sort((a, b) => a - b),
          aggregateOutputCounts: aggData?.aggregateOutputCounts ?? [],
          newOutputCount: aggData?.newOutputCount ?? (block.outputs.length - sc),
        };
      },
    };
    const outputSpace = new OutputSpaceModule(virtualProvider);

    // -- 5. Lower direct ClaimRef -> claim indices -------------------
    //
    // Value is looked up from the producing block. Drafts only run once
    // their producers are present, so this lookup always succeeds.
    const claims: ClaimEntry[] = [];
    for (const c of draft.claims) {
      const idx = outputSpace.computeClaimIndex(virtualHash, {
        block: c.producer,
        outputIndex: c.outputIndex,
      });
      if (idx === undefined) {
        // Producer isn't reachable from the virtual block's extended
        // vector. Anchor selection should have prevented this; if it
        // happens, treat as awaitingAnchor for retry.
        return { ok: false, awaitingAnchor: true, missing: [c.producer] };
      }
      const producer = store.get(c.producer);
      const value = producer?.outputs[c.outputIndex]?.value ?? 0;
      claims.push({ index: idx, value });
    }
    // Self-claims target the block's own outputs directly. Value is 0
    // (records are economically neutral).
    for (const idx of selfClaimedIndices) {
      claims.push({ index: idx, value: 0 });
    }

    // -- 6. Composed claim mask + aggregation output patch -----------
    const composedClaimMask = outputSpace.subtreeClaimMask(virtualHash) ?? [];
    let outputs = patchAggregationOutput(
      draft.outputs,
      composedClaimMask,
      aggregateOutputCounts,
      virtualBlock.newOutputCount,
      chainWeights,
      aggregateWeights,
    );

    // -- 7. Value override -------------------------------------------
    //
    // Allow the configured hook to raise `value` on `requestBody`-produced
    // slots before signing. Verifier + data are frozen; only value may
    // change, and only upward.
    if (this.provider.valueOverride) {
      outputs = applyValueOverride(outputs, draft.outputSlots, this.provider.valueOverride);
    }

    // -- 8. Sign ------------------------------------------------------
    const spec: BlockSpec = {
      anchor,
      outputs,
      claims,
      declaredWeight: draft.declaredWeight,
      aggregates,
      refs: draft.refs,
    };
    const block = this.provider.createBlock(spec, this.provider.privateKey);
    if (!block) return { ok: false, reason: 'sign failed' };
    return { ok: true, block };
  }

  /**
   * Solidify a batch of drafts into a single block.
   *
   * `seedDrafts` are the drafts the caller explicitly wants to publish.
   * `pool` is the set of additional `ready`/`solidifying` drafts available
   * to be merged in if autobalance needs more inputs (managed by
   * DraftManager).
   *
   * For now this is a thin shim: size-1 batches with an empty pool
   * delegate to the existing single-draft `build`. Multi-draft batches
   * and pool-driven autobalance are filled in in subsequent migration
   * steps.
   */
  solidify(
    seedDrafts: Draft[],
    pool: Draft[],
    opts?: {
      aggregatedBlocks?: Hash[];
      excludedBlocks?: Hash[];
    },
  ): BuildResult {
    if (seedDrafts.length === 0) {
      return { ok: false, reason: 'no seed drafts' };
    }
    if (seedDrafts.length === 1 && pool.length === 0) {
      return this.build(seedDrafts[0], opts);
    }
    return { ok: false, reason: 'multi-draft solidify not yet implemented' };
  }
}

/** Dedupe a list of Hashes, preserving first-seen order. */
function dedupeHashes(hashes: Hash[]): Hash[] {
  const seen = new Set<string>();
  const out: Hash[] = [];
  for (const h of hashes) {
    const key = h.toHex();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * If the draft produces an aggregation data output (from running the
 * aggregation contract), patch it with the structural fields and weight
 * info computed by BlockBuilder from store-resident state. The contract
 * fills in only the cache shape -- weight values come from here.
 * No-op for blocks that aren't aggregators.
 */
function patchAggregationOutput(
  outputs: Output[],
  claimMask: number[],
  aggregateOutputCounts: number[],
  newOutputCount: number,
  chainWeights: number[],
  aggregateWeights: number[],
): Output[] {
  return outputs.map((output) => {
    if (!HashCtor.equals(output.verifier.contract, AGGREGATION_CONTRACT)) return output;
    if (output.body === undefined) return output; // data-less marker
    if (output.body.length === 0) return output; // empty-bytes marker (legacy)

    const aggData = getAggregationData({
      outputs: [output],
    } as Block);
    if (!aggData) return output;

    return {
      ...output,
      body: encodeAggregationData({
        ...aggData,
        claimMask,
        aggregateOutputCounts,
        newOutputCount,
        chainWeights,
        aggregateWeights,
      }),
    };
  });
}

/**
 * Walk `from`'s anchor chain toward genesis; return the depth at which
 * `target` appears (0 if `from === target`), or undefined if it doesn't.
 */
function anchorChainDepth(
  store: BlockStore,
  from: Hash,
  target: Hash,
): number | undefined {
  let cur: Hash = from;
  let depth = 0;
  const seen = new Set<HashPrimitive>();
  while (!HashCtor.equals(cur, ZERO_HASH)) {
    if (HashCtor.equals(cur, target)) return depth;
    const key = cur.toPrimitive();
    if (seen.has(key)) return undefined;
    seen.add(key);
    const block = store.get(cur);
    if (!block) return undefined;
    cur = block.anchor;
    depth++;
  }
  if (HashCtor.equals(target, ZERO_HASH)) return depth;
  return undefined;
}

/**
 * Compose chainWeights from per-aggregate `{anchorDepth, weightVector}`.
 * Mirrors `BlockCreationModule.deriveWeightVector` with own declaredWeight
 * = 0 (chainWeights excludes the block's own weight by convention).
 */
function composeChainWeights(
  subtreeInfos: { anchorDepth: number; weightVector: number[] }[],
): number[] {
  let maxDepth = -1;
  for (const st of subtreeInfos) {
    if (st.weightVector.length === 0) continue;
    const stMax = st.anchorDepth + st.weightVector.length - 1;
    if (stMax > maxDepth) maxDepth = stMax;
  }
  if (maxDepth < 0) return [];
  const out: number[] = new Array(maxDepth + 1).fill(0);
  for (const st of subtreeInfos) {
    for (let i = 0; i < st.weightVector.length; i++) {
      out[st.anchorDepth + i] += st.weightVector[i];
    }
  }
  return out;
}

/**
 * Apply the value-override hook to every `requestBody`-sourced slot. The
 * hook sees `(verifier, data, defaultValue)` and returns the final
 * value. Verifier + data are frozen; only value changes. Non-`get`
 * slots and slots without data pass through unchanged.
 *
 * `outputs` and `slots` are parallel arrays. `slots` may be shorter
 * than `outputs` for drafts created outside the generation pipeline
 * (test fixtures, phantom drafts) -- those entries default to `require`
 * origin and pass through.
 */
function applyValueOverride(
  outputs: Output[],
  slots: OutputSlot[],
  override: ValueOverrideFn,
): Output[] {
  return outputs.map((output, i) => {
    const slot = slots[i];
    if (!slot || slot.origin !== 'get') return output;
    if (output.body === undefined) return output;
    const newValue = override(output.verifier, output.body, output.value);
    if (newValue === output.value) return output;
    return { ...output, value: newValue };
  });
}
