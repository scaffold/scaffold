import { SIGNATURE_CONTRACT_HASH } from '../Config.ts';
import { Context } from '../Context.ts';
import { arrCall } from '../util/array.ts';
import { assert } from '../util/functional.ts';
import { secp } from '../util/secp.ts';
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
  Output,
} from './types.ts';

// Only exported for tests
export const SIGNATURE_OUTPUT_PAYLOAD: unique symbol = Symbol('SIGNATURE_OUTPUT_PAYLOAD');

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

    if (draft.status.type !== DraftStatusType.Built) {
      draft.status = { type: DraftStatusType.Cancelled, cancelledReason: 'cancelled' };
    }
  }

  // ioDelta = sum(outputs) - sum(claims)
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

    const selectedDrafts = this.balanceFunds(draft);
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
    }, true);

    draft.status.hooks.abort();
    for (const selDraft of selectedDrafts) {
      if (selDraft.type === DRAFT_TYPE) {
        selDraft.status = { type: DraftStatusType.Built, block };
      }
    }

    // Trigger downstream listeners, first for the new block then for the draft
    this.ctx.get(BlockStore).doSkippedIngestion(block);
    for (const selDraft of selectedDrafts) {
      if (selDraft.type === DRAFT_TYPE) {
        arrCall(selDraft.listeners, block);
      }
    }
  }

  private balanceFunds(draft: Draft) {
    const result: (Draft | (DraftPayload & { type: typeof SIGNATURE_OUTPUT_PAYLOAD }))[] = [draft];

    let amount = draft.ioDelta;

    if (amount > 0n) {
      const candidates = [...this.drafts]
        .filter((x) =>
          x !== draft &&
          x.status.type === DraftStatusType.Ready &&
          x.ioDelta < 0n
        )
        // Sort from high to low (low magnitude negative to high magnitude negative)
        .sort((a, b) => Number(b.ioDelta - a.ioDelta));

      let lim: number;
      for (lim = 0; lim < candidates.length && amount > 0n; lim++) {
        amount += candidates[lim].ioDelta;
      }

      for (let i = 0; i < lim; i++) {
        if (amount - candidates[i].ioDelta <= 0n) {
          amount -= candidates[i].ioDelta;
        } else {
          result.push(candidates[i]);
        }
      }
    }

    if (amount < 0n) {
      result.push({
        type: SIGNATURE_OUTPUT_PAYLOAD,
        claims: [],
        refs: [],
        outputs: [{
          contract: SIGNATURE_CONTRACT_HASH,
          params: secp.getPublicKey(this.ctx.config.selfPrivateKey, true),
          amount: -amount,
        }],
      });
    }

    return result;
  }

  private mergeDrafts(drafts: DraftPayload[]): DraftPayload {
    type Link = DraftPayload['claims'][number];

    const claims: Link[] = [];
    const refs: Link[] = [];
    const outputs: Output[] = [];

    for (const draft of drafts) {
      // A DRAFT_SELF index addresses the draft's own output vector, which moves to
      // `offset` once the preceding drafts' outputs are in front of it.
      const offset = BigInt(outputs.length);
      const remap = (link: Link): Link => {
        if (link.producer !== DRAFT_SELF) return link;
        assert(
          link.outputIndex >= 0n && link.outputIndex < BigInt(draft.outputs.length),
          `Self link index ${link.outputIndex} out of bounds`,
        );
        return { producer: DRAFT_SELF, outputIndex: link.outputIndex + offset };
      };

      claims.push(...draft.claims.map(remap));
      refs.push(...draft.refs.map(remap));
      outputs.push(...draft.outputs);
    }

    return { claims, refs, outputs };
  }
}
