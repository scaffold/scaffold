import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
import { Draft, DraftStore } from './Draft.ts';
import { ConsensusConfig, ConsensusModule, ConsensusProvider } from './ConsensusModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import { pickAnchorForClaims } from './AnchorSelection.ts';

/** Entity type that consensus operates on: either a finalized Block or a local Draft. */
export type ConsensusEntity = Block | Draft;

function isBlock(entity: ConsensusEntity): entity is Block {
  return 'hash' in entity;
}

class ConsensusProviderAdapter implements ConsensusProvider<ConsensusEntity> {
  private draftStore?: DraftStore;

  constructor(private readonly store: BlockStore) {}

  /** Wire a DraftStore so drafts are visible to consensus. */
  setDraftStore(ds: DraftStore): void {
    this.draftStore = ds;
  }

  getBlock(hash: Hash): ConsensusEntity | undefined {
    return this.store.get(hash) ?? this.draftStore?.get(hash);
  }

  getHash(entity: ConsensusEntity): Hash {
    return isBlock(entity) ? entity.hash : entity.draftId;
  }

  getAnchor(entity: ConsensusEntity): Hash {
    if (isBlock(entity)) return entity.anchor;
    // Drafts derive their anchor from their claims via the same
    // selection logic that BlockBuilder uses at solidification. This
    // ensures pre-solidification weight attribution lands on the same
    // chain that the eventual block will, so weight doesn't appear or
    // disappear when the draft solidifies.
    const pick = pickAnchorForClaims(entity.claims, this.store);
    return pick.ok ? pick.anchor : ZERO_HASH;
  }

  getAggregates(entity: ConsensusEntity): Hash[] {
    if (isBlock(entity)) return entity.aggregates;
    // Same selection logic as getAnchor -- a draft that claims B and C
    // both anchored to A reports anchor=A, aggregates=[B,C], which is
    // identical to a real aggregator block over B+C. Weight propagates
    // through that chain.
    const pick = pickAnchorForClaims(entity.claims, this.store);
    return pick.ok ? pick.aggregates : [];
  }

  getWeightVector(entity: ConsensusEntity): number[] {
    if (isBlock(entity)) return getBlockWeightVector(entity);
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
    super(adapter, config);
    this.adapter = adapter;
  }

  /** Wire a DraftStore so drafts participate in consensus as phantom blocks. */
  setDraftStore(draftStore: DraftStore): void {
    this.adapter.setDraftStore(draftStore);
  }
}
