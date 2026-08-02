import { Query } from '../contract/Query.ts';
import { Context } from '../Context.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { Hash } from '../util/Hash.ts';
import { arrEquals } from '../util/buffer.ts';
import { BlockStore } from '../graph/BlockStore.ts';
import { Block, DraftStatusType } from '../graph/types.ts';
import { OutputIndex } from '../graph/OutputIndex.ts';
import { neverAbort } from '../util/abortable.ts';
import { createSource } from '../contract/createSource.ts';

export interface FetchInput extends Query {
  signal?: AbortSignal;
  onResult: (result: FetchResult | null) => void;
}

export interface FetchResult {
  readonly body: Uint8Array;
  parse(): Promise<unknown>;
}

export class Fetch {
  constructor(private ctx: Context) {}

  /** Public API: subscribe to a verifier with per-caller projection. */
  async fetch({ contract, params, signal, onResult }: FetchInput) {
    if (signal?.aborted) return;

    if (!(params instanceof Uint8Array)) {
      params = await this.ctx.get(this.ctx.config.contractPlugin).buildParams(contract, params);
    }

    let hasResult = false;
    this.ctx.get(OutputIndex).onOutput({ contract, params }, (output) => {
      // Only outputs with data
      if (output.output.data === undefined) return;

      // Only self-claimed outputs
      if (!output.producer.payload.claims.includes(BigInt(output.outputIndex))) return;

      onResult({ body: output.output.data, parse: () => Promise.resolve(output.output.data) });
      hasResult = true;
    }, signal ?? neverAbort);

    if (!hasResult) {
      const draft = this.ctx.get(DraftStore).create({
        outputs: [{ contract, params, amount: 0n }],
      });
      this.ctx.get(DraftStore).build(draft);

      signal?.addEventListener('abort', () => this.ctx.get(DraftStore).cancel(draft));
    }
  }
}
