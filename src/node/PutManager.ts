// User-facing draft API. Thin wrapper around DraftManager that adds
// keyed create-or-update semantics and a `publish: false` parking mode.
//
// Architecture: DraftManager (in src/core/) is the single bottleneck for
// all draft + block creation. PutManager is one caller of it. Other
// callers (the post-generation hook in GenerationService, the strategy
// action handlers in ReactiveLayer, DemoNode.publishStatus) call
// DraftManager directly.
//
// See docs/protocol/draft-blocks.md.

import { AGGREGATION_CONTRACT, Block, RECORD_CONTRACT } from '../core/Block.ts';
import { makeAggregationOutput } from '../contracts/AggregationContract.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { DraftManager } from '../core/DraftManager.ts';
import type { Draft } from '../core/Draft.ts';
import type { ClaimRef } from '../core/Node.ts';
import { str2bin } from '../util/buffer.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Primitive } from '../util/types.ts';

/**
 * Resolved claim: a direct (producer, outputIndex) reference. Drafts
 * only run once their producing block is in the local store, so
 * outputIndex is always a real index into producer.outputs.
 */
export type PutClaim = ClaimRef;

/** Request to put data into the network */
export interface PutRequest {
  /** Claims (producer, outputIndex) the new draft will consume. */
  claims?: PutClaim[];
  /** Outputs the new draft will produce. */
  outputs?: Output[];
  /**
   * Convenience: each (key, value) becomes a RECORD_CONTRACT output
   * with `verifier.params = utf8(key)` and `data = utf8(value)`.
   */
  records?: Record<string, Uint8Array | string>;
  /** Declared work weight for the draft. Default 1. */
  declaredWeight?: number;
  /**
   * Identifier for keyed updates. Repeated puts with the same key
   * extend the existing draft (until it's published or cancelled).
   * Without a key, every call creates a fresh draft.
   */
  key?: Primitive | Hash;
  /**
   * If true, the draft is solidified into a block immediately after
   * creation/update. If false, the draft is parked in `ready` and only
   * published by a subsequent `put({ key, publish: true })` call.
   * Default: true.
   */
  publish?: boolean;
}

export interface PutResult {
  /** The draft created or updated by this call. */
  draftId: Hash;
  /**
   * The produced block, if `publish: true` succeeded synchronously.
   * Null when the draft is parked (`publish: false`) or solidify is
   * still in flight (`awaitingAnchor`).
   */
  block: Block | null;
  /** Convenience accessor: `block?.hash ?? null`. */
  hash: Hash | null;
}

export class PutManager {
  // Active keyed drafts. Evicted on publication or cancellation.
  private readonly keyed = new Map<string, Hash>();

  constructor(private readonly draftManager: DraftManager) {}

  /**
   * Create or update a draft, optionally publishing it as a block.
   *
   * - With `key` + `publish: false`: park the draft. Subsequent puts
   *   with the same key extend it (append claims/outputs) until
   *   published.
   * - With `publish: true` (default): solidify immediately. On success,
   *   the produced block is returned and the key is evicted from the
   *   keyed map (so a subsequent same-key call creates a fresh draft).
   * - On `awaitingAnchor` (no canonical anchor yet): the draft stays
   *   in `solidifying`. The internal retry loop (configured in
   *   DraftManager) will re-attempt as the chain advances.
   */
  put(request: PutRequest): PutResult {
    const outputs = this._normalizeOutputs(request);
    const claims = request.claims ?? [];
    const declaredWeight = request.declaredWeight ?? 1;
    const publish = request.publish !== false;
    const keyStr = request.key !== undefined ? this._normalizeKey(request.key) : undefined;

    // 1. Locate or create the draft.
    let draft = keyStr !== undefined ? this._lookupByKeyStr(keyStr) : undefined;
    if (draft) {
      const phase = draft.status.phase;
      if (phase === 'solidifying') {
        throw new Error(
          `PutManager.put: draft for key ${keyStr} is already solidifying; cannot mutate`,
        );
      }
      if (phase !== 'ready' && phase !== 'readyToSolidify' && phase !== 'pending') {
        // Terminal: the keyed map should have evicted this entry. Be
        // defensive and treat as a miss.
        if (keyStr !== undefined) this.keyed.delete(keyStr);
        draft = undefined;
      }
    }

    if (!draft) {
      draft = this.draftManager.addReady({
        claims: [...claims],
        outputs: [...outputs],
        declaredWeight,
      });
      if (keyStr !== undefined) this.keyed.set(keyStr, draft.draftId);
    } else if (claims.length > 0 || outputs.length > 0) {
      draft = this.draftManager.update(draft.draftId, {
        claims: [...draft.claims, ...claims],
        outputs: [...draft.outputs, ...outputs],
      });
    }

    // 2. If parking, return now.
    if (!publish) {
      return { draftId: draft.draftId, block: null, hash: null };
    }

    // 3. Solidify. On success, evict the key (per spec: published key
    // is deleted from the map; subsequent same-key calls start fresh).
    const result = this.draftManager.solidify([draft]);
    if (keyStr !== undefined) this.keyed.delete(keyStr);

    if (result.ok) {
      return { draftId: draft.draftId, block: result.block, hash: result.block.hash };
    }
    // awaitingAnchor or hard reason: draft is still in `solidifying`.
    // The retry loop is responsible for eventually producing the block.
    return { draftId: draft.draftId, block: null, hash: null };
  }

  /** Cancel a keyed draft. Evicts the key. */
  cancel(key: Primitive | Hash, reason?: string): void {
    const keyStr = this._normalizeKey(key);
    const draftId = this.keyed.get(keyStr);
    if (!draftId) return;
    this.keyed.delete(keyStr);
    this.draftManager.cancelDraft(draftId, reason ?? 'cancelled by put');
  }

  /** Look up the active draft for a given key, if any. */
  get(key: Primitive | Hash): Draft | undefined {
    const keyStr = this._normalizeKey(key);
    return this._lookupByKeyStr(keyStr);
  }

  // -- internals -----------------------------------------------------

  private _normalizeOutputs(request: PutRequest): Output[] {
    const out = [...(request.outputs ?? [])];
    if (request.records) {
      for (const [key, value] of Object.entries(request.records)) {
        out.push({
          verifier: { contract: RECORD_CONTRACT, params: str2bin(key) },
          value: 0,
          data: typeof value === 'string' ? str2bin(value) : value,
        });
      }
    }
    // Every non-genesis block carries an aggregation marker output. The
    // generator-driven path adds this via the AggregationContract; the
    // direct (skipGeneration / PutManager) path adds it here.
    const hasMarker = out.some((o) =>
      (o.data === undefined || o.data.length === 0) &&
      o.verifier.contract.toHex() === AGGREGATION_CONTRACT.toHex()
    );
    if (!hasMarker) out.push(makeAggregationOutput());
    return out;
  }

  private _normalizeKey(key: Primitive | Hash): string {
    if (key instanceof Hash) return `h:${(key.toPrimitive() as HashPrimitive).toString()}`;
    return `p:${String(key)}`;
  }

  private _lookupByKeyStr(keyStr: string): Draft | undefined {
    const draftId = this.keyed.get(keyStr);
    if (!draftId) return undefined;
    return this.draftManager.get(draftId);
  }
}
