// Protocol spec: docs/protocol/weight-propagation.md
//
// Adapter wiring NodeWeightsModule to BlockStore + DraftStore. Uses Hash as
// NodeId so the service composes with everything that already keys on block
// hash or draft id.
//
// Drafts participate as full nodes in the propagation graph, mirroring how
// ConsensusService treats them as phantom blocks. A draft's anchor is
// derived from its claims via placement (the same logic ConsensusService
// and BlockBuilder use), and its selfWeight is `max(declaredWeight,
// effectiveWeight)` -- consistent with what ConsensusService.getWeightVector
// reports today. Drafts have no aggregates of their own (per placement.md):
// aggregation is an explicit operation by the AggregationContract, not a
// consequence of multi-branch claims.
//
// SamplingService is consumed lazily (via ctx.maybeGet) so unit tests that
// stand up only the propagation layer keep working. When sampling is wired,
// blocks' selfWeight and weightVector are scaled by the per-block weight
// factor so the propagation sees verified weight, not raw declared weight.
//
// derivedWeightVector and descendantWeight are memoised across calls,
// invalidated whenever the store grows, a draft is added/transitioned, or a
// sampling weight factor changes. Without this, getConflictWinner would
// trigger an O(graph) walk per candidate.

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
import { Draft, DraftStore } from './Draft.ts';
import { Node } from './Node.ts';
import { NodeWeightsModule, NodeWeightsProvider } from './NodeWeightsModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { SamplingService } from './SamplingService.ts';
import { draftAnchorViaPlacement } from './DraftPlacement.ts';
import { PlacementModule } from './PlacementModule.ts';

class NodeWeightsProviderAdapter implements NodeWeightsProvider<Hash> {
  /** Reverse index: block -> blocks/drafts that aggregate it. Lazily built. */
  private parentsIndex: Map<HashPrimitive, Hash[]> | null = null;
  /** Reverse index: block -> blocks/drafts that anchor to it. Lazily built. */
  private anchorChildrenIndex: Map<HashPrimitive, Hash[]> | null = null;
  /**
   * Bumps when the store changes, when a draft is added/transitioned, or
   * when a sampling weight factor changes. Invalidates both the lazy reverse
   * indices and the per-call caches in the enclosing NodeWeightsService.
   */
  version = 0;
  private indexVersion = -1;

  private draftStore: DraftStore | undefined;
  private placement: PlacementModule<Block> | undefined;

  ignoredNodes: Node[] = [];

  constructor(
    private readonly store: BlockStore,
    private readonly sampling: SamplingService | undefined,
  ) {
    store.onAdded(() => {
      this.version++;
    });
    sampling?.onWeightChange(() => {
      this.version++;
    });
  }

  setDraftStore(ds: DraftStore): void {
    this.draftStore = ds;
    ds.onAdded(() => {
      this.version++;
    });
    ds.onTransition(() => {
      this.version++;
    });
  }

  /** Wire placement so drafts derive their anchor consistently with BlockBuilder. */
  setPlacement(placement: PlacementModule<Block>): void {
    this.placement = placement;
    this.version++;
  }

  selfWeight(id: Hash): number {
    const b = this.store.get(id);
    if (b) {
      const factor = this.sampling?.getWeightFactor(id) ?? 1;
      return b.declaredWeight * factor;
    }
    const d = this.draftStore?.get(id);
    if (d) return Math.max(d.declaredWeight, d.effectiveWeight);
    return 0;
  }

  weightVector(id: Hash): number[] {
    const b = this.store.get(id);
    if (b) {
      const factor = this.sampling?.getWeightFactor(id) ?? 1;
      const wv = getBlockWeightVector(b);
      return factor === 1 ? wv : wv.map((w) => w * factor);
    }
    // Drafts have no aggregation cache; their entire contribution is selfWeight.
    return [];
  }

  aggregates(id: Hash): Hash[] {
    const b = this.store.get(id);
    if (b) return [...b.aggregates];
    // Drafts have no aggregates of their own (per placement.md).
    return [];
  }

  anchor(id: Hash): Hash | null {
    const b = this.store.get(id);
    if (b) return Hash.equals(b.anchor, ZERO_HASH) ? null : b.anchor;
    const d = this.draftStore?.get(id);
    if (d) {
      const anchor = draftAnchorViaPlacement(d, this.store, this.placement);
      return Hash.equals(anchor, ZERO_HASH) ? null : anchor;
    }
    return null;
  }

  anchoringChildren(id: Hash): Hash[] {
    this.ensureIndices();
    return this.anchorChildrenIndex!.get(id.toPrimitive()) ?? [];
  }

  parents(id: Hash): Hash[] {
    this.ensureIndices();
    return this.parentsIndex!.get(id.toPrimitive()) ?? [];
  }

  key(id: Hash): string {
    return id.toPrimitive();
  }

  private ensureIndices(): void {
    if (this.indexVersion === this.version) return;
    const parents = new Map<HashPrimitive, Hash[]>();
    const anchorChildren = new Map<HashPrimitive, Hash[]>();

    const noteAnchor = (id: Hash, anchor: Hash) => {
      if (Hash.equals(anchor, ZERO_HASH)) return;
      const k = anchor.toPrimitive();
      const arr = anchorChildren.get(k) ?? [];
      arr.push(id);
      anchorChildren.set(k, arr);
    };
    const noteAggregates = (id: Hash, aggs: Hash[]) => {
      for (const agg of aggs) {
        const k = agg.toPrimitive();
        const arr = parents.get(k) ?? [];
        arr.push(id);
        parents.set(k, arr);
      }
    };

    for (const block of this.store.values()) {
      if (this.ignoredNodes.includes(block)) continue;
      noteAnchor(block.hash, block.anchor);
      noteAggregates(block.hash, block.aggregates);
    }

    if (this.draftStore) {
      for (const d of this.draftStore.getAll()) {
        if (this.ignoredNodes.includes(d)) continue;
        // Only consider drafts still alive in consensus -- terminal drafts
        // should not contribute weight (their solidified replacement is a
        // real Block in the store now). Match ConsensusService's draft-as-
        // phantom-block convention: every non-terminal draft participates.
        if (this.isTerminalDraft(d)) continue;
        const anchor = draftAnchorViaPlacement(d, this.store, this.placement);
        if (Hash.equals(anchor, ZERO_HASH)) continue;
        noteAnchor(d.draftId, anchor);
        // Drafts contribute no aggregates (per placement.md).
      }
    }

    this.parentsIndex = parents;
    this.anchorChildrenIndex = anchorChildren;
    this.indexVersion = this.version;
  }

  private isTerminalDraft(d: Draft): boolean {
    return d.status.phase === 'solidified' || d.status.phase === 'failed';
  }
}

/**
 * NodeWeightsModule wired to a BlockStore (and optionally DraftStore) via
 * ProtocolContext. Memoises `derivedWeightVector` and `descendantWeight`
 * across calls, invalidated by the adapter's version counter.
 */
export class NodeWeightsService extends NodeWeightsModule<Hash> {
  private readonly adapter: NodeWeightsProviderAdapter;
  private derivedCache = new Map<HashPrimitive, number[]>();
  private descendantCache = new Map<HashPrimitive, number>();
  private cacheVersion = -1;

  constructor(ctx: ProtocolContext) {
    const adapter = new NodeWeightsProviderAdapter(
      ctx.get(BlockStore),
      ctx.maybeGet(SamplingService),
    );
    super(adapter);
    this.adapter = adapter;
  }

  /** Wire a DraftStore so drafts participate in propagation as phantom blocks. */
  setDraftStore(draftStore: DraftStore): void {
    this.adapter.setDraftStore(draftStore);
  }

  /** Wire placement so drafts derive their anchor consistently with BlockBuilder. */
  setPlacement(placement: PlacementModule<Block>): void {
    this.adapter.setPlacement(placement);
  }

  withIgnoredNodes<T>(node: Node, fn: () => T): T {
    this.adapter.ignoredNodes.push(node);
    try {
      return fn();
    } finally {
      if (this.adapter.ignoredNodes.pop() !== node) {
        console.error('Ignored nodes stack mismatch');
      }
    }
  }

  override derivedWeightVector(id: Hash): number[] {
    this.ensureFreshCaches();
    const k = id.toPrimitive();
    const hit = this.derivedCache.get(k);
    if (hit) return hit;
    const v = super.derivedWeightVector(id);
    this.derivedCache.set(k, v);
    return v;
  }

  override descendantWeight(id: Hash): number {
    this.ensureFreshCaches();
    const k = id.toPrimitive();
    const hit = this.descendantCache.get(k);
    if (hit !== undefined) return hit;
    const w = super.descendantWeight(id);
    this.descendantCache.set(k, w);
    return w;
  }

  private ensureFreshCaches(): void {
    if (this.cacheVersion === this.adapter.version) return;
    this.derivedCache.clear();
    this.descendantCache.clear();
    this.cacheVersion = this.adapter.version;
  }
}
