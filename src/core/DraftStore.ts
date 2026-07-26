import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { AtomSerializerService } from './AtomSerializer.ts';
import { BlockBuilderService } from './BlockBuilderModule2.ts';
import { BlockStore } from './BlockStore.ts';
import {
  AtomSource,
  AtomType,
  Block,
  Draft,
  DRAFT_TYPE,
  DraftStatus,
  DraftStatusType,
} from './types.ts';

export class DraftStore {
  private drafts = new Set<Draft>();

  constructor(private ctx: Context) {}

  onBuilt(draft: Draft, cb: (block?: Block) => void, signal?: AbortSignal) {
    if (signal?.aborted) return;
    draft.listeners.add(cb);
    if (draft.status.type === DraftStatusType.Built) {
      cb(draft.status.block);
    }
    signal?.addEventListener('abort', () => assert(draft.listeners.delete(cb)));
  }

  upsert(
    { claims, refs, outputs }: Partial<Pick<Draft, 'claims' | 'refs' | 'outputs'>>,
    replace?: Draft,
  ) {
    if (replace === undefined) {
      replace = {
        type: DRAFT_TYPE,
        claims: [],
        refs: [],
        outputs: [],
        status: { type: DraftStatusType.Populating },
        builtBlocks: [],
        listeners: new Set(),
      };
      this.drafts.add(replace);
    }
    assert(replace.status.type === DraftStatusType.Populating);

    replace.claims = claims ?? [];
    replace.refs = refs ?? [];
    replace.outputs = outputs ?? [];

    return replace;
  }

  lock(draft: Draft) {
    assert(draft.status.type === DraftStatusType.Populating);
    draft.status = { type: DraftStatusType.Locked };
  }

  build(draft: Draft) {
    assert(
      draft.status.type === DraftStatusType.Populating ||
        draft.status.type === DraftStatusType.Locked,
    );
    draft.status = {
      type: DraftStatusType.Building,
      stalledReason: { msg: 'not tried yet' },
      hooks: new AbortController(),
    };

    this.attemptBuild(draft);
    if (draft.status.type === DraftStatusType.Building) {
      this.ctx.get(BlockStore).onIngest(() => this.attemptBuild(draft), draft.status.hooks.signal);
    }
  }

  cancel(draft: Draft) {
    if (draft.status.type === DraftStatusType.Building) {
      draft.status.hooks.abort();
    }
    draft.status = { type: DraftStatusType.Cancelled, cancelledReason: 'cancelled' };
  }

  private attemptBuild(draft: Draft) {
    assert(draft.status.type === DraftStatusType.Building);

    const result = this.ctx.get(BlockBuilderService).build(draft);
    if (!result.ok) {
      draft.status.stalledReason = {};
      return;
    }

    const serialized = this.ctx.get(AtomSerializerService).serialize(
      AtomType.Block,
      result.payload,
    );
    const block = this.ctx.get(BlockStore).ingest({
      source: AtomSource.Local,
      receivedAt: this.ctx.config.timeProvider.now(),
      raw: serialized,
    });

    draft.status.hooks.abort();
    draft.status = { type: DraftStatusType.Built, block };
  }
}
