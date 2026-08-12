import { Context } from '../Context.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { neverAbort } from '../util/abortable.ts';
import { Hash } from '../util/Hash.ts';
import { GenerationJob } from '../graph/GenerationJob.ts';
import { ExecutionQueue } from './ExecutionQueue.ts';
import { Block, Draft, Predicate } from '../graph/types.ts';
import { assert } from '../util/functional.ts';
import { Query } from '../contract/Query.ts';
import { SourceRoot } from '../contract/values.ts';

/*
TODO: What's a good interface for Scaffold.put?
- Is the ability to put multiple predicates onto the same block important?
- How should we pass capabilities? Capabilities look suspiciously like other contracts; they (1) generate some kind of data, and (2) verify that data.
*/

export interface PutInput extends Query {
  claimBlocks?: Hash[];
  result?: Uint8Array | SourceRoot;
  outputs?: { predicate: Predicate; body: Uint8Array; amount: bigint }[];
  capabilities?: {}[];

  signal?: AbortSignal;
  onBlock?: (block?: Block) => void;
}

export class Put {
  constructor(private ctx: Context) {}

  async put(
    { contract, params, claimBlocks, result, outputs, capabilities, signal, onBlock }: PutInput,
  ) {
    signal ??= neverAbort;
    if (signal.aborted) return;

    // Temporary constraints on the interface for now
    assert(claimBlocks === undefined);
    assert(outputs === undefined);
    assert(capabilities === undefined);

    if (typeof contract === 'string') {
      contract = Hash.fromHex(contract);
    }

    if (!(params instanceof Uint8Array)) {
      params = await this.ctx.get(this.ctx.config.contractPlugin).buildParams(contract, params);
    }
    if (result !== undefined && !(result instanceof Uint8Array)) {
      result = await this.ctx.get(this.ctx.config.contractPlugin).buildBody(contract, result);
    }

    const onDraft = onBlock
      ? (draft: Draft) => this.ctx.get(DraftStore).onBuilt(draft, onBlock, signal)
      : undefined;

    const job = new GenerationJob(this.ctx, { contract, params }, { body: result }, onDraft);
    await this.ctx.get(ExecutionQueue).run(job);
    this.ctx.get(ExecutionQueue).remove(job);
  }
}
