import { Query } from '../contract/Query.ts';
import { Context } from '../Context.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { OutputIndex } from '../graph/OutputIndex.ts';
import { neverAbort } from '../util/abortable.ts';
import { createSink } from '../contract/createSink.ts';
import { Hash } from '../util/Hash.ts';
import { GenerationJob } from '../graph/GenerationJob.ts';
import { ExecutionQueue } from './ExecutionQueue.ts';
import { Block, Draft } from '../graph/types.ts';

export interface PutInput extends Query {
  result: Uint8Array;
  signal?: AbortSignal;
  onBlock?: (block?: Block) => void;
}

export interface PutResult {
  block: Hash;
}

export class Put {
  constructor(private ctx: Context) {}

  // TODO: Make this non-async?
  async put({ contract, params, result, signal, onBlock }: PutInput) {
    signal ??= neverAbort;

    if (signal.aborted) return;

    if (typeof contract === 'string') {
      contract = Hash.fromHex(contract);
    }

    if (!(params instanceof Uint8Array)) {
      params = await this.ctx.get(this.ctx.config.contractPlugin).buildParams(contract, params);
    }

    const onDraft = onBlock
      ? (draft: Draft) => this.ctx.get(DraftStore).onBuilt(draft, onBlock, signal)
      : undefined;

    const job = new GenerationJob(this.ctx, { contract, params }, { result }, onDraft);
    this.ctx.get(ExecutionQueue).run(job)
      .then(() => this.ctx.get(ExecutionQueue).remove(job));
  }
}
