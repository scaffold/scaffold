import { Query } from '../interfaces/Query.ts';
import { Context } from '../Context.ts';
import { DraftStore } from '../core/DraftStore.ts';
import { Hash } from '../util/Hash.ts';
import { arrEquals } from '../util/buffer.ts';
import { BlockStore } from '../core/BlockStore.ts';

export interface FetchInput {
  query: Query;
  signal?: AbortSignal;
  onResult: (result: FetchResult | null) => void;
}

export interface FetchResult {
  readonly body: Uint8Array;
  parse(): Promise<unknown>;
}

export class FetchService {
  constructor(private ctx: Context) {}

  /** Public API: subscribe to a verifier with per-caller projection. */
  fetch(input: FetchInput) {
    if (!(input.query.params instanceof Uint8Array)) {
      throw new Error(`Reader-based params are not supported yet`);
    }
    const params = input.query.params;

    const draft = this.ctx.get(DraftStore).create({
      outputs: [{ contract: input.query.contract, params: input.query.params, amount: 0n }],
    });
    this.ctx.get(DraftStore).build(draft);

    // this.ctx.get(DraftStore).onBuilt(draft, (block) => {
    //   if (block === undefined) return;
    //   const outputIdx = BigInt(
    //     block.payload.outputs.findIndex((output) =>
    //       Hash.equals(output.contract, input.query.contract) && arrEquals(output.params, params)
    //     ),
    //   );
    //   block.listeners.add((action) => {
    //     if (
    //       action.type === BlockActionType.LinkClaimingNode && action.claim.outputIdx === outputIdx
    //     ) {
    //       console.log('claim');
    //     }
    //   });
    // }, input.signal);

    this.ctx.get(BlockStore).onIngest((block) => {
      for (const claim of block.payload.claims) {
        if (claim < BigInt(block.payload.outputs.length)) {
          const output = block.payload.outputs[Number(claim)];
          if (
            output.data !== undefined &&
            Hash.equals(output.contract, input.query.contract) &&
            arrEquals(output.params, params)
          ) {
            input.onResult({ body: output.data, parse: () => Promise.resolve(output.data) });
          }
        }
      }
    }, input.signal);
  }
}
