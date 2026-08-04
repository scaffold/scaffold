import { Query, Statement } from '../contract/Query.ts';
import { Context } from '../Context.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { Hash } from '../util/Hash.ts';

export interface SendInput extends Statement {
  amount: bigint;
  signal?: AbortSignal;
}

export class Send {
  constructor(private ctx: Context) {}

  /** Public API: subscribe to a verifier with per-caller projection. */
  send({ contract, params, data, amount, signal }: SendInput) {
    if (signal?.aborted) return;

    if (typeof contract === 'string') {
      contract = Hash.fromHex(contract);
    }

    if (!(params instanceof Uint8Array)) {
      throw new Error(`Reader-based params are not supported yet`);
    }

    if (!(data instanceof Uint8Array)) {
      throw new Error(`Reader-based data are not supported yet`);
    }

    const draft = this.ctx.get(DraftStore).create({
      outputs: [{ contract, params, data, amount }],
    });
    this.ctx.get(DraftStore).build(draft);

    signal?.addEventListener('abort', () => this.ctx.get(DraftStore).cancel(draft));
  }
}
