import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, getBlockWeightVector } from './Block.ts';
import { Draft, DraftStore } from './Draft.ts';
import { ConsensusConfig, ConsensusModule, ConsensusProvider } from './ConsensusModule.ts';
import { ProtocolContext } from './ProtocolContext.ts';

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
    return entity.anchor;
  }

  getAggregates(entity: ConsensusEntity): Hash[] {
    return entity.aggregates;
  }

  getWeightVector(entity: ConsensusEntity): number[] {
    if (isBlock(entity)) return getBlockWeightVector(entity);
    return [entity.declaredWeight];
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
