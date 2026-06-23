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
import { Query, Record } from '../interfaces/Query.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ObjectReader, Reader } from '../interfaces/Reader.ts';

/** Publish records under a verifier by running its contract generator. */
export interface PutRequest extends Query {
  /**
   * Records that answer the generator's `request({RECORD_CONTRACT, key})`
   * calls. Each entry's value is returned as the body to the generator.
   */
  records: Record[];
  // records:
  //   | Record<string, Uint8Array | ((descriptor: string) => MaybePromise<Reader>)>
  //   | ObjectReader;
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
    const records = await Promise.all(
      request.records.map((x) => this.contractHost.resolveRecordData(x)),
    );
    const verifier = { contract: request.contract, params };

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
