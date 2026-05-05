// Protocol spec: docs/protocol/weight-propagation.md
//
// Adapter wiring NodeWeightsModule to BlockStore. Uses Hash as NodeId so the
// service composes with everything that already keys on block hash. The
// adapter subtracts `block.declaredWeight` back out of `weightVector[0]` --
// that fold belongs in `Block.ts` proper but the upstream refactor (see
// TODO.md) hasn't landed yet, so the service keeps the propagation module
// honest in the meantime.

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { BlockStore, getBlockWeightVector } from './Block.ts';
import { NodeWeightsModule, NodeWeightsProvider } from './NodeWeightsModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

class NodeWeightsProviderAdapter implements NodeWeightsProvider<Hash> {
  /** Reverse index: block -> blocks that aggregate it. Lazily built. */
  private parentsIndex: Map<HashPrimitive, Hash[]> | null = null;
  /** Reverse index: block -> blocks that anchor to it. Lazily built. */
  private anchorChildrenIndex: Map<HashPrimitive, Hash[]> | null = null;
  /** Bumps when the store changes; invalidates the lazy indices. */
  private storeVersion = 0;
  private indexVersion = -1;

  constructor(private readonly store: BlockStore) {
    store.onAdded(() => {
      this.storeVersion++;
    });
  }

  selfWeight(id: Hash): number {
    const b = this.store.get(id);
    return b ? b.declaredWeight : 0;
  }

  weightVector(id: Hash): number[] {
    const b = this.store.get(id);
    if (!b) return [];
    // getBlockWeightVector folds declaredWeight into [0]; the propagation
    // module wants only the aggregated subtree's contribution, so peel it
    // back off. (TODO.md: split this in Block.ts itself.)
    const v = [...getBlockWeightVector(b)];
    if (v.length > 0) v[0] -= b.declaredWeight;
    return v;
  }

  aggregates(id: Hash): Hash[] {
    const b = this.store.get(id);
    return b ? [...b.aggregates] : [];
  }

  anchor(id: Hash): Hash | null {
    const b = this.store.get(id);
    if (!b) return null;
    if (Hash.equals(b.anchor, ZERO_HASH)) return null;
    return b.anchor;
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
    if (this.indexVersion === this.storeVersion) return;
    const parents = new Map<HashPrimitive, Hash[]>();
    const anchorChildren = new Map<HashPrimitive, Hash[]>();
    for (const block of this.store.values()) {
      if (!Hash.equals(block.anchor, ZERO_HASH)) {
        const k = block.anchor.toPrimitive();
        const arr = anchorChildren.get(k) ?? [];
        arr.push(block.hash);
        anchorChildren.set(k, arr);
      }
      for (const agg of block.aggregates) {
        const k = agg.toPrimitive();
        const arr = parents.get(k) ?? [];
        arr.push(block.hash);
        parents.set(k, arr);
      }
    }
    this.parentsIndex = parents;
    this.anchorChildrenIndex = anchorChildren;
    this.indexVersion = this.storeVersion;
  }
}

/** NodeWeightsModule wired to a BlockStore via ProtocolContext. */
export class NodeWeightsService extends NodeWeightsModule<Hash> {
  constructor(ctx: ProtocolContext) {
    super(new NodeWeightsProviderAdapter(ctx.get(BlockStore)));
  }
}
