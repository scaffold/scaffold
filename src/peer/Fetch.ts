import { Query } from '../contract/Query.ts';
import { Context } from '../Context.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { OutputIndex } from '../graph/OutputIndex.ts';
import { neverAbort } from '../util/abortable.ts';
import { createSink } from '../contract/createSink.ts';
import { Hash } from '../util/Hash.ts';

export interface FetchInput extends Query {
  signal?: AbortSignal;
  onResult: (result: FetchResult | null) => void;
}

export interface FetchResult {
  body: Uint8Array;
  parse(): Promise<unknown>;
}

export class Fetch {
  constructor(private ctx: Context) {}

  // TODO: Make this non-async?
  async fetch({ contract, params, signal, onResult }: FetchInput) {
    signal ??= neverAbort;
    if (signal.aborted) return;

    if (typeof contract === 'string') {
      contract = Hash.fromHex(contract);
    }

    if (!(params instanceof Uint8Array)) {
      params = await this.ctx.get(this.ctx.config.contractPlugin).buildParams(contract, params);
    }

    let hasResult = false;
    this.ctx.get(OutputIndex).onOutput({ contract, params }, (output) => {
      const body = output.output.data;

      // Only outputs with data
      if (body === undefined) return;

      // Only self-claimed outputs
      if (!output.producer.payload.claims.includes(BigInt(output.outputIndex))) return;

      onResult({
        body,
        parse: () =>
          createSink((sink) =>
            this.ctx.get(this.ctx.config.contractPlugin).walkData(contract, body, sink)
          ),
      });
      hasResult = true;
    }, signal);

    if (!hasResult) {
      const draft = this.ctx.get(DraftStore).create({
        outputs: [{ contract, params, amount: 0n }],
      });
      this.ctx.get(DraftStore).build(draft);

      signal.addEventListener('abort', () => this.ctx.get(DraftStore).cancel(draft));
    }
  }
}
