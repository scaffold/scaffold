// User-facing send primitive. Publishes a single output under a verifier
// and fires `onBlock` every time the underlying draft produces a block --
// initial emission plus every re-emission after the previous block becomes
// uncanonical. Mirrors `onIncentive` inside fetch.
//
// `send` returns a `SendHandle`. Closing it cancels the underlying draft
// (no more re-emissions) and unsubscribes the callbacks. Used by
// FetchManager to publish its incentive block (so that path picks up
// re-emit on uncanonical for free).
//
// Requires canonicality of the resulting block for the output to be
// effective on the network; the draft pipeline retries automatically.

import { Block } from '../core/Block.ts';
import { makeAggregationOutput } from '../contracts/AggregationContract.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { DraftStore } from '../core/Draft.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { Hash } from '../util/Hash.ts';
import { encodeParams } from './draftPublishing.ts';

/** Publish a single output under a verifier. */
export interface SendRequest {
  /** Output's verifier contract hash. */
  contract: Hash;
  /**
   * Output's verifier params. Pre-encoded bytes, or a key-value object
   * that `contract.buildParams` will encode.
   */
  params: Uint8Array | Record<string, unknown>;
  /** Output body. */
  body: Uint8Array;
  /** Output value (economic weight on the wire). Default 0. */
  value?: number;
  /**
   * Fires on every block produced from the draft -- initial emission plus
   * each re-emission after the previous block became uncanonical.
   */
  onBlock?: (block: Block) => void;
  /** Fires if the underlying draft is cancelled before producing any block. */
  onError?: (err: Error) => void;
}

export interface SendHandle {
  /**
   * Cancel the underlying draft (no more re-emissions) and unsubscribe
   * callbacks.
   */
  close(): void;
}

export class SendManager {
  constructor(
    private readonly draftManager: DraftManager,
    private readonly draftStore: DraftStore,
    private readonly contractHost: ContractHostService,
  ) {}

  /**
   * Publish a single output under the supplied verifier and return a
   * handle. `onBlock` fires each time the draft produces a block.
   */
  send(request: SendRequest): SendHandle {
    const params = encodeParams(request.contract, request.params, this.contractHost);
    const outputs: Output[] = [
      {
        verifier: { contract: request.contract, params },
        value: request.value ?? 0,
        body: request.body,
      },
      makeAggregationOutput(),
    ];

    const draft = this.draftManager.addReady({
      claims: [],
      outputs,
      declaredWeight: 1,
    });

    let lastEmittedHash: string | null = null;
    let unsub: (() => void) | null = null;
    // Listener registration must happen BEFORE solidify so the
    // synchronous solidified transition (anchor already canonical) is
    // observed.
    unsub = this.draftStore.onTransition((d) => {
      if (!Hash.equals(d.draftId, draft.draftId)) return;
      if (d.status.phase === 'solidified' && d.solidifiedBlocks.length > 0) {
        const block = d.solidifiedBlocks[d.solidifiedBlocks.length - 1];
        const hex = block.hash.toHex();
        // Each draft re-solidification appends to solidifiedBlocks; the
        // transition listener fires once per appended block. Dedup by
        // hash anyway in case onTransition fires twice for the same
        // phase-stable solidified state (defensive).
        if (lastEmittedHash === hex) return;
        lastEmittedHash = hex;
        request.onBlock?.(block);
      } else if (d.status.phase === 'cancelled') {
        unsub?.();
        unsub = null;
        request.onError?.(new Error(`send draft cancelled: ${d.status.reason}`));
      }
    });

    this.draftManager.solidify([draft]);

    return {
      close: () => {
        if (unsub) {
          unsub();
          unsub = null;
        }
        const current = this.draftStore.get(draft.draftId);
        if (current && current.status.phase !== 'cancelled') {
          this.draftManager.cancelDraft(draft.draftId, 'send handle closed');
        }
      },
    };
  }
}
