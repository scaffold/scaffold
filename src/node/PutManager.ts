// User-facing put primitive. Runs the contract generator for
// `(contract, params)` with the supplied `records` answering every
// `env.request({contract: RECORD_CONTRACT, params: utf8(key)})` call.
//
// Strict matching:
//   - Unmatched request -> draft cancelled, Promise rejects.
//   - Unused record key -> draft cancelled, Promise rejects.
//
// The generator owns the draft via GenerationService.generateForVerifier;
// PutManager only listens on `DraftStore.onTransition` for the
// solidified-or-cancelled outcome. Re-emissions after uncanonical happen
// silently through the standard draft retry loop (the Promise resolves
// on the first emit).

import { Block } from '../core/Block.ts';
import { DraftStore } from '../core/Draft.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { GenerationService } from './GenerationService.ts';
import { Hash } from '../util/Hash.ts';
import { Query } from '../interfaces/Query.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { Reader } from '../interfaces/Reader.ts';

/**
 * Publish a verifier by running its contract generator. Provide EITHER:
 *  - `data`: the data-based result model -- a single answer payload the
 *    contract's `getResult()` consumes, published as the self-claimed answer
 *    under the verifier (see docs/protocol/results.md); OR
 *  - `records`: the deprecated multi-record map (contract registration); each
 *    entry answers a `request({RECORD_CONTRACT, key})` call.
 */
export interface PutRequest extends Query {
  data?: Uint8Array | ((descriptor: string) => MaybePromise<Reader>);
  records?: { [key: string]: Uint8Array | string };
}

export class PutManager {
  constructor(
    private readonly generation: GenerationService,
    private readonly draftStore: DraftStore,
    private readonly contractHost: ContractHostService,
  ) {}

  /**
   * Run the contract generator for `(contract, params)` and resolve with
   * the first block produced. Rejects if the draft is cancelled (e.g. an
   * unmatched request, an unused record, a contract throw).
   */
  async put(request: PutRequest): Promise<Block> {
    const params = await this.contractHost.resolveQueryParams(request);
    const verifier = { contract: request.contract, params };

    // A single `data` answer payload is installed under the conventional
    // empty-string key (consumed by the contract's getResult via
    // GenerationService.resolveGetResult). Otherwise pass the deprecated
    // multi-record map through verbatim.
    let records: { [key: string]: Uint8Array | string };
    if (request.data !== undefined) {
      const dataBytes = request.data instanceof Uint8Array
        ? request.data
        : await this.contractHost.resolveRecordData({
          contract: request.contract,
          params,
          data: request.data,
        });
      records = { '': dataBytes };
    } else {
      records = request.records ?? {};
    }

    return new Promise<Block>((resolve, reject) => {
      let handle: { draftId: Hash; cancel: () => void };
      try {
        handle = this.generation.generateForVerifier(verifier, records);
      } catch (e) {
        reject(e);
        return;
      }
      const targetId = handle.draftId;

      let unsub: (() => void) | null = null;
      // Register the transition listener BEFORE the async run completes
      // (generation.generateForVerifier enqueues; the run happens on a
      // later tick), so we never miss the solidified/cancelled transition.
      unsub = this.draftStore.onTransition((d) => {
        if (!Hash.equals(d.draftId, targetId)) return;
        if (d.status.phase === 'solidified' && d.solidifiedBlocks.length > 0) {
          unsub?.();
          resolve(d.solidifiedBlocks[d.solidifiedBlocks.length - 1]);
        } else if (d.status.phase === 'cancelled') {
          unsub?.();
          reject(new Error(`put draft cancelled: ${d.status.reason}`));
        }
      });
    });
  }
}
