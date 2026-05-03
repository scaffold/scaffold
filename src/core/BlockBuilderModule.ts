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
import { RECORD_CONTRACT } from './Block.ts';
import { Hash as HashCtor } from '../util/Hash.ts';
import type { Output, BlockSpec, ClaimEntry } from './BlockCreationModule.ts';
import type { Draft } from './Draft.ts';
import {
  encodeAggregationData,
  getAggregationData,
} from '../contracts/AggregationContract.ts';
import { AGGREGATION_CONTRACT } from './Block.ts';
import {
  type OutputSpaceBlock,
  OutputSpaceModule,
  type OutputSpaceProvider,
} from './OutputSpace.ts';
import type { OutputSlot } from './GeneratingEnv.ts';
import type { Verifier } from './BlockCreationModule.ts';

/**
 * Solidification-time value-override function. Called for every slot
 * whose origin is `'get'`. Returns the final `value` for that output
 * (must be `>= defaultValue` -- the partition check at verification
 * rejects lowered values). `verifier` and `data` are frozen at
 * generation time and are supplied here for context.
 */
export type ValueOverrideFn = (
  verifier: Verifier,
  data: Uint8Array,
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
  /** Sign a BlockSpec into a Block. May return null on signing failure. */
  createBlock(spec: BlockSpec, privateKey: Uint8Array | null): Block | null;
  /** Optional value-override hook for `getOutput` slots. */
  valueOverride: ValueOverrideFn | null;
  /** Private key for signing, or null for unsigned blocks. */
  privateKey: Uint8Array | null;
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
  build(draft: Draft): BuildResult {
    // -- 1. Collect unique claim producers ---------------------------
    const producerSet = new Set<string>();
    const producers: Hash[] = [];
    for (const c of draft.claims) {
      const key = c.producer.toPrimitive();
      if (producerSet.has(key)) continue;
      producerSet.add(key);
      producers.push(c.producer);
    }
    if (producers.length === 0) {
      // Drafts must consume at least one input -- there's no current
      // producer-less code path.
      return { ok: false, reason: 'draft has no claims' };
    }

    // -- 2. Anchor selection: deepest common ancestor of producers ---
    const pick = pickAnchor(producers, this.provider.store);
    if (!pick.ok) {
      return { ok: false, awaitingAnchor: true, missing: pick.missing };
    }
    const { anchor, aggregates } = pick;

    // Build per-aggregate output counts from cached aggregation data
    // (or leaf defaults).
    const aggregateOutputCounts: number[] = [];
    for (const aggHash of aggregates) {
      const aggBlock = this.provider.store.get(aggHash);
      if (!aggBlock) {
        aggregateOutputCounts.push(0);
        continue;
      }
      const aggData = getAggregationData(aggBlock);
      const sc = aggBlock.claimIndices.filter((c) => c < aggBlock.outputs.length).length;
      aggregateOutputCounts.push(aggData?.newOutputCount ?? (aggBlock.outputs.length - sc));
    }

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
    );

    // -- 7. Value override -------------------------------------------
    //
    // Allow the configured hook to raise `value` on `getOutput`-produced
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
}

/** Deepest common ancestor of `producers` in the store's anchor chain. */
function pickAnchor(
  producers: Hash[],
  store: BlockStore,
): { ok: true; anchor: Hash; aggregates: Hash[] } | { ok: false; missing: Hash[] } {
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
  // producers is minimal (i.e. closest to all of them).
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
    return { ok: false, missing: producers };
  }

  // Producers that aren't the anchor itself become aggregate references.
  const anchorKey = best.toPrimitive();
  const aggregates = producers.filter((p) => p.toPrimitive() !== anchorKey);
  return { ok: true, anchor: best, aggregates };
}

/**
 * If the draft produces an aggregation data output (from running the
 * aggregation contract), patch it with the computed claim mask. No-op
 * for blocks that aren't aggregators.
 */
function patchAggregationOutput(
  outputs: Output[],
  claimMask: number[],
  aggregateOutputCounts: number[],
  newOutputCount: number,
): Output[] {
  return outputs.map((output) => {
    if (!HashCtor.equals(output.verifier.contract, AGGREGATION_CONTRACT)) return output;
    if (output.data === null) return output; // null-data marker
    if (output.data.length === 0) return output; // empty-bytes marker (legacy)

    const aggData = getAggregationData({
      outputs: [output],
    } as Block);
    if (!aggData) return output;

    return {
      ...output,
      data: encodeAggregationData({
        ...aggData,
        claimMask,
        aggregateOutputCounts,
        newOutputCount,
      }),
    };
  });
}

/**
 * Apply the value-override hook to every `getOutput`-sourced slot. The
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
    if (output.data === null) return output;
    const newValue = override(output.verifier, output.data, output.value);
    if (newValue === output.value) return output;
    return { ...output, value: newValue };
  });
}
