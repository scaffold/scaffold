import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, getBlockTotalWeightVector } from './Block.ts';
import { Draft, DraftStore } from './Draft.ts';
import { ConsensusConfig, ConsensusModule, ConsensusProvider } from './ConsensusModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { draftAnchorViaPlacement } from './DraftPlacement.ts';
import { PlacementModule } from './PlacementModule.ts';
import { NodeWeightsService } from './NodeWeightsService.ts';

/** Entity type that consensus operates on: either a finalized Block or a local Draft. */
export type ConsensusEntity = Block | Draft;

function isBlock(entity: ConsensusEntity): entity is Block {
  return 'hash' in entity;
}

class ConsensusProviderAdapter implements ConsensusProvider<ConsensusEntity> {
  private draftStore?: DraftStore;
  private placement?: PlacementModule<Block>;

  constructor(private readonly store: BlockStore) {}

  /** Wire a DraftStore so drafts are visible to consensus. */
  setDraftStore(ds: DraftStore): void {
    this.draftStore = ds;
  }

  /** Wire placement so drafts derive their anchor consistently with BlockBuilder. */
  setPlacement(placement: PlacementModule<Block>): void {
    this.placement = placement;
  }

  getBlock(hash: Hash): ConsensusEntity | undefined {
    return this.store.get(hash) ?? this.draftStore?.get(hash);
  }

  getHash(entity: ConsensusEntity): Hash {
    return isBlock(entity) ? entity.hash : entity.draftId;
  }

  getAnchor(entity: ConsensusEntity): Hash {
    if (isBlock(entity)) return entity.anchor;
    // Drafts derive their anchor via placement (same logic as
    // BlockBuilder uses at solidification), so pre-solidification weight
    // lands on the same chain the eventual block will. ZERO_HASH means
    // the draft has no anchor yet (stalled or no placement wired) -- it
    // contributes no weight.
    return draftAnchorViaPlacement(entity, this.store, this.placement);
  }

  getAggregates(entity: ConsensusEntity): Hash[] {
    if (isBlock(entity)) return entity.aggregates;
    // Drafts have no aggregates of their own -- aggregation is an
    // explicit operation produced by the AggregationContract, not an
    // implicit consequence of having multi-branch claims. A draft's
    // weight propagates purely through its anchor chain.
    return [];
  }

  getWeightVector(entity: ConsensusEntity): number[] {
    if (isBlock(entity)) return getBlockTotalWeightVector(entity);
    // Drafts contribute their effectiveWeight (wall-clock-bumped, plus
    // declaredWeight as a floor) as a single-dimensional weight vector,
    // attributed through the picked anchor's chain. Step 8 wires the
    // ticker that grows effectiveWeight over a draft's lifetime; until
    // then effectiveWeight is initialised to 0 and declaredWeight is
    // the de-facto static contribution.
    return [Math.max(entity.declaredWeight, entity.effectiveWeight)];
  }
}

/** ConsensusModule wired to a BlockStore (and optionally DraftStore) via ProtocolContext. */
export class ConsensusService extends ConsensusModule<ConsensusEntity> {
  private readonly adapter: ConsensusProviderAdapter;

  constructor(ctx: ProtocolContext, config?: ConsensusConfig) {
    const store = ctx.get(BlockStore);
    const adapter = new ConsensusProviderAdapter(store);
    // Route effective weight through NodeWeightsService when available so
    // blocks and drafts share the propagation model from
    // docs/protocol/weight-propagation.md. NodeWeightsService.selfWeight
    // already handles both blocks (declaredWeight * sampling factor) and
    // drafts (max declaredWeight, effectiveWeight). User-supplied
    // `config.effectiveWeight` wins if set.
    const nodeWeights = ctx.maybeGet(NodeWeightsService);
    const effectiveWeight = config?.effectiveWeight ??
      (nodeWeights
        ? (h: Hash) => nodeWeights.selfWeight(h) + nodeWeights.descendantWeight(h)
        : undefined);
    super(adapter, { ...config, effectiveWeight });
    this.adapter = adapter;
  }

  /** Wire a DraftStore so drafts participate in consensus as phantom blocks. */
  setDraftStore(draftStore: DraftStore): void {
    this.adapter.setDraftStore(draftStore);
  }

  /** Wire placement so drafts derive their anchor via the same logic as BlockBuilder. */
  setPlacement(placement: PlacementModule<Block>): void {
    this.adapter.setPlacement(placement);
  }
}
