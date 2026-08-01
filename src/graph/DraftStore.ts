import { Context } from '../Context.ts';
import { AGGREGATION_CONTRACT } from '../contract/static/Aggregation.ts';
import { SIGNATURE_CONTRACT } from '../contract/static/Signature.ts';
import { arrCall } from '../util/array.ts';
import { assert } from '../util/functional.ts';
import { Hash } from '../util/Hash.ts';
import { secp } from '../util/secp.ts';
import { AtomSerializer } from './AtomSerializer.ts';
import { BlockBuilder } from './BlockBuilder.ts';
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
export const EXTRA_OUTPUT_PAYLOAD: unique symbol = Symbol('EXTRA_OUTPUT_PAYLOAD');

type ExtraPayload = DraftPayload & { type: typeof EXTRA_OUTPUT_PAYLOAD };

// A block is merged from drafts plus whatever payloads the merge has to mint itself.
type MergeEntry = Draft | ExtraPayload;

export class DraftStoreConfig {
  // Fee carried by the aggregation output every block we build attaches (wp 7)
  aggregationFee = 0n;
}

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
    const result = this.ctx.get(BlockBuilder).build(mergedDraft);
    if (!result.ok) {
      draft.status.stalledReason = {};
      return;
    }

    const serialized = this.ctx.get(AtomSerializer)
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

    console.log(`Built block ${block.hash.toHex()}:`, result.payload);
    debugger;

    // Trigger downstream listeners, first for the new block then for the draft
    this.ctx.get(BlockStore).doSkippedIngestion(block);
    for (const selDraft of selectedDrafts) {
      if (selDraft.type === DRAFT_TYPE) {
        arrCall(selDraft.listeners, block);
      }
    }
  }

  // Structure first, funds second. Satisfying wp 7 can only add value to the block
  // -- an aggregation draft earns fees, a minted output costs one -- so the deficit
  // is known before any funding candidate is chosen, and the two phases don't circle.
  private balanceFunds(draft: Draft) {
    const result: MergeEntry[] = [draft];

    const aggregation = this.providesAggregation(draft) ? undefined : this.takeAggregation();
    let amount = draft.ioDelta + (aggregation === undefined ? 0n : this.entryDelta(aggregation));

    if (amount > 0n) {
      const candidates = [...this.drafts]
        .filter((x) =>
          x !== draft &&
          x.status.type === DraftStatusType.Ready &&
          x.ioDelta < 0n &&
          // A second one would make the block aggregatable twice (wp 4.3, 7)
          !this.providesAggregation(x)
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
        type: EXTRA_OUTPUT_PAYLOAD,
        claims: [],
        refs: [],
        outputs: [{
          contract: SIGNATURE_CONTRACT,
          params: secp.getPublicKey(this.ctx.config.selfPrivateKey, true),
          amount: -amount,
        }],
      });
    }

    if (aggregation !== undefined) {
      result.push(aggregation);
    }

    const markers = result.flatMap((x) => x.outputs)
      .filter((x) => Hash.equals(x.contract, AGGREGATION_CONTRACT));
    assert(
      markers.length === 1,
      `A block carries exactly one aggregation output, merged ${markers.length}`,
    );

    return result;
  }

  private providesAggregation(payload: DraftPayload): boolean {
    return payload.outputs.some((x) => Hash.equals(x.contract, AGGREGATION_CONTRACT));
  }

  // wp 7: every block but the genesis carries one. An aggregation block brings its
  // own, a ready one rides along on whatever we publish next, otherwise we mint one.
  private takeAggregation(): MergeEntry {
    for (const candidate of this.drafts) {
      if (candidate.status.type !== DraftStatusType.Ready) continue;
      if (this.providesAggregation(candidate)) return candidate;
    }

    return {
      type: EXTRA_OUTPUT_PAYLOAD,
      claims: [],
      refs: [],
      // No params: the contract takes none, so any aggregator can claim it (wp 7)
      outputs: [{
        contract: AGGREGATION_CONTRACT,
        params: new Uint8Array(),
        amount: this.ctx.get(DraftStoreConfig).aggregationFee,
      }],
    };
  }

  private entryDelta(entry: MergeEntry): bigint {
    return entry.type === DRAFT_TYPE
      ? entry.ioDelta
      : this.computeIoDelta(entry.claims, entry.outputs);
  }

  private mergeDrafts(drafts: DraftPayload[]): DraftPayload {
    type Link = DraftPayload['claims'][number];

    const claims: Link[] = [];
    const refs: Link[] = [];
    const outputs: Output[] = [];

    for (const draft of drafts) {
      // A DRAFT_SELF index addresses the draft's own output vector, which moves to
      // `offset` once the preceding drafts' outputs are in front of it.
      const remap = (link: Link): Link => {
        if (link.producer !== DRAFT_SELF) return link;
        assert(
          link.outputIndex >= 0n && link.outputIndex < BigInt(draft.outputs.length),
          `Self link index ${link.outputIndex} out of bounds`,
        );
        return { producer: DRAFT_SELF, outputIndex: link.outputIndex + outputs.length };
      };

      claims.push(...draft.claims.map(remap));
      refs.push(...draft.refs.map(remap));
      outputs.push(...draft.outputs);
    }

    return { claims, refs, outputs };
  }
}
