import { Query } from '../interfaces/Query.ts';
import { Context } from '../Context.ts';
import { DraftStore } from '../core/DraftStore.ts';
import { Hash } from '../util/Hash.ts';
import { arrEquals } from '../util/buffer.ts';
import { BlockStore } from '../core/BlockStore.ts';
import { Block, DraftStatusType } from '../core/types.ts';

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
    if (input.signal?.aborted) return;

    if (!(input.query.params instanceof Uint8Array)) {
      throw new Error(`Reader-based params are not supported yet`);
    }
    const { contract, params } = input.query;

    const testBlock = (block: Block): boolean => {
      for (const claim of block.payload.claims) {
        if (claim < BigInt(block.payload.outputs.length)) {
          const output = block.payload.outputs[Number(claim)];
          if (
            output.data !== undefined &&
            Hash.equals(output.contract, contract) &&
            arrEquals(output.params, params)
          ) {
            input.onResult({ body: output.data, parse: () => Promise.resolve(output.data) });
            return true;
          }
        }
      }
      return false;
    };

    for (const block of this.ctx.get(BlockStore).getAll()) {
      if (testBlock(block)) return;
    }

    const draft = this.ctx.get(DraftStore).create({
      outputs: [{ contract, params, amount: 0n }],
    });
    this.ctx.get(DraftStore).build(draft);

    input.signal?.addEventListener('abort', () => this.ctx.get(DraftStore).cancel(draft));

    // this.ctx.get(DraftStore).onBuilt(draft, (block) => {
    //   if (block === undefined) return;
    //   const outputIdx = BigInt(
    //     block.payload.outputs.findIndex((output) =>
    //       Hash.equals(output.contract, contract) && arrEquals(output.params, params)
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

    this.ctx.get(BlockStore).onIngest(testBlock, input.signal);
  }
}
