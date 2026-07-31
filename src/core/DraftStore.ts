import { Context } from '../Context.ts';
import { arrCall } from '../util/array.ts';
import { assert } from '../util/functional.ts';
import { AtomSerializerService } from './AtomSerializer.ts';
import { BlockBuilderService } from './BlockBuilderModule2.ts';
import { BlockStore } from './BlockStore.ts';
import {
  AtomSource,
  AtomType,
  Block,
  Draft,
  DRAFT_SELF,
  DRAFT_TYPE,
  DraftPayload,
  DraftStatusType,
} from './types.ts';

export class DraftStore {
  // TODO: When should we delete from this set?
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

  create(attrs?: Partial<DraftPayload>): Draft {
    const draft: Draft = {
      type: DRAFT_TYPE,
      claims: [],
      refs: [],
      outputs: [],
      status: { type: DraftStatusType.Populating },
      ioDelta: 0n,
      builtBlocks: [],
      listeners: new Set(),
    };
    this.drafts.add(draft);

    if (attrs !== undefined) {
      this.update(draft, { claims: [], refs: [], outputs: [], ...attrs });
    }

    return draft;
  }

  update(draft: Draft, { claims, refs, outputs }: DraftPayload) {
    assert(draft.status.type === DraftStatusType.Populating);

    draft.claims = claims;
    draft.refs = refs;
    draft.outputs = outputs;
    draft.ioDelta = this.computeIoDelta(claims, outputs);
  }

  lock(draft: Draft) {
    assert(draft.status.type === DraftStatusType.Populating);
    draft.status = { type: DraftStatusType.Ready };
  }

  build(draft: Draft) {
    assert(
      draft.status.type === DraftStatusType.Populating ||
        draft.status.type === DraftStatusType.Ready,
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

  private computeIoDelta(claims: Draft['claims'], outputs: Draft['outputs']): bigint {
    let acc = 0n;
    for (const claim of claims) {
      const outputVec = claim.producer === DRAFT_SELF ? outputs : claim.producer.payload.outputs;
      acc -= outputVec[Number(claim.outputIndex)].amount;
    }
    for (const output of outputs) {
      acc += output.amount;
    }
    return acc;
  }

  private attemptBuild(draft: Draft) {
    assert(draft.status.type === DraftStatusType.Building);

    let selectedDrafts: Draft[];
    if (draft.ioDelta > 0n) {
      selectedDrafts = [draft, ...this.selectReadyFunds(draft.ioDelta)];
    } else {
      selectedDrafts = [draft];
    }

    const mergedDraft = this.mergeDrafts(selectedDrafts);
    const result = this.ctx.get(BlockBuilderService).build(mergedDraft);
    if (!result.ok) {
      draft.status.stalledReason = {};
      return;
    }

    const serialized = this.ctx.get(AtomSerializerService)
      .serialize(AtomType.Block, result.payload);
    const block = this.ctx.get(BlockStore).ingest({
      source: AtomSource.Local,
      receivedAt: this.ctx.config.timeProvider.nowMs(),
      raw: serialized,
    });

    draft.status.hooks.abort();
    for (const selDraft of selectedDrafts) {
      selDraft.status = { type: DraftStatusType.Built, block };
      arrCall(selDraft.listeners, block);
    }
  }

  private selectReadyFunds(amount: bigint) {
    assert(amount > 0n);

    const candidates: Draft[] = [];
    for (const draft of this.drafts) {
      if (draft.status.type === DraftStatusType.Ready && draft.ioDelta < 0n) {
        candidates.push(draft);
      }
    }

    // Sort from high to low (low magnitude to high magnitude)
    candidates.sort((a, b) => Number(b.ioDelta - a.ioDelta));

    let lim: number;
    for (lim = 0; lim < candidates.length; lim++) {
      amount += candidates[lim].ioDelta;
      if (amount <= 0n) break;
    }

    const selected: Draft[] = [];
    for (let i = 0; i < lim; i++) {
      if (amount - candidates[i].ioDelta <= 0n) {
        amount -= candidates[i].ioDelta;
      } else {
        selected.push(candidates[i]);
      }
    }
    return selected;
  }

  private mergeDrafts(drafts: DraftPayload[]): DraftPayload {
    // TODO(claude): Remap DRAFT_SELF claims/refs to the merged draft
    return {
      claims: drafts.flatMap((d) => d.claims),
      refs: drafts.flatMap((d) => d.refs),
      outputs: drafts.flatMap((d) => d.outputs),
    };
  }
}
