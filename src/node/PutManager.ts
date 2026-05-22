// User-facing put primitive. Publishes a verifier output paired with one
// RECORD_CONTRACT output per supplied record on a new draft.
//
// `put` returns `Promise<Block>` that resolves on the first block produced
// from the draft. The draft pipeline (DraftManager._retrySolidifying) keeps
// re-emitting if the block becomes uncanonical, but `put` callers only see
// the first emission -- the promise resolves once, and follow-up emissions
// (if any) happen silently. Callers who care about re-emissions should use
// `send` instead.
//
// Does not require canonicality of the resulting block.
// See docs/protocol/draft-blocks.md.

import { Block, RECORD_CONTRACT } from '../core/Block.ts';
import { makeAggregationOutput } from '../contracts/AggregationContract.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { DraftStore } from '../core/Draft.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { Hash } from '../util/Hash.ts';
import { str2bin } from '../util/buffer.ts';
import { encodeParams } from './draftPublishing.ts';

/** Publish records under a verifier. Does not require canonicality. */
export interface PutRequest {
  /** Verifier-output contract hash. */
  contract: Hash;
  /**
   * Verifier-output params. Pre-encoded bytes, or a key-value object that
   * `contract.buildParams` will encode (requires the contract to be
   * registered).
   */
  params: Uint8Array | Record<string, unknown>;
  /**
   * Records to publish on the same block. Each entry becomes a
   * RECORD_CONTRACT output whose `verifier.params = utf8(key)` and
   * `body = utf8(value)`.
   */
  records: Record<string, Uint8Array | string>;
}

export class PutManager {
  constructor(
    private readonly draftManager: DraftManager,
    private readonly draftStore: DraftStore,
    private readonly contractHost: ContractHostService,
  ) {}

  /**
   * Publish a verifier with fitting records on a new draft. Resolves with
   * the first block produced from the draft. Rejects if the draft is
   * cancelled before any block is produced.
   */
  put(request: PutRequest): Promise<Block> {
    const params = encodeParams(request.contract, request.params, this.contractHost);
    const outputs: Output[] = [
      // Verifier marker output: makes the block discoverable as the
      // publisher of `(contract, params)`. Body-less so it's pure
      // incentive / signal, not data.
      { verifier: { contract: request.contract, params }, value: 0 },
    ];
    for (const [key, value] of Object.entries(request.records)) {
      outputs.push({
        verifier: { contract: RECORD_CONTRACT, params: str2bin(key) },
        value: 0,
        body: typeof value === 'string' ? str2bin(value) : value,
      });
    }
    outputs.push(makeAggregationOutput());

    return new Promise<Block>((resolve, reject) => {
      const draft = this.draftManager.addReady({
        claims: [],
        outputs,
        declaredWeight: 1,
      });
      // Listener registration must happen BEFORE solidify so the
      // synchronous solidified transition (anchor already canonical) is
      // observed.
      let unsub: (() => void) | null = null;
      unsub = this.draftStore.onTransition((d) => {
        if (!Hash.equals(d.draftId, draft.draftId)) return;
        if (d.status.phase === 'solidified' && d.solidifiedBlocks.length > 0) {
          unsub?.();
          resolve(d.solidifiedBlocks[d.solidifiedBlocks.length - 1]);
        } else if (d.status.phase === 'cancelled') {
          unsub?.();
          reject(new Error(`put draft cancelled: ${d.status.reason}`));
        }
      });
      this.draftManager.solidify([draft]);
    });
  }
}
