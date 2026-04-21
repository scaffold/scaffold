/**
 * Incremental UTXO index keyed by verifier (contract + params).
 *
 * The index reflects the current canonical UTXO set. It is maintained
 * eagerly: every canonicality change on a block or draft mutates the
 * index so `getByVerifier` returns a pre-built, correct set with no
 * read-time filtering.
 *
 *   - Canonical block: add its own outputs, remove the outputs it claims.
 *   - Non-canonical block: reverse.
 *   - Canonical draft: remove the outputs its `resolvedClaims` point at.
 *     (Drafts don't produce indexable outputs -- only the real block
 *     produced on publication does.)
 *   - Non-canonical draft: re-add the outputs its `resolvedClaims`
 *     reserved.
 *
 * Wire via `ConsensusService.onCanonicalityChange`: resolve the hash via
 * `BlockStore` first, then `DraftStore`, and call the appropriate method
 * on this index.
 */

import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import { Block, BlockStore, collectExtendedOutputs } from '../core/Block.ts';
import type { BlockDraft } from '../core/BlockDraft.ts';

/** A single unspent output tracked by the index. */
export interface UtxoEntry {
  /** Hash of the block that produced this output. */
  blockHash: Hash;
  /** Index within the block's own outputs array. */
  outputIndex: number;
  /** Economic value. */
  value: number;
  /**
   * Index in the anchor block's extended output vector.
   * For outputs of the genesis block, this equals `outputIndex`.
   */
  extendedIndex: number;
}

/** Compute a verifier key from contract hash and params. */
export function verifierKey(contract: Hash, params: Uint8Array): string {
  return contract.toHex() + ':' + bin2hex(params);
}

/** Compute a unique key for an output entry. */
function outputKey(blockHash: Hash, outputIndex: number): string {
  return blockHash.toHex() + ':' + outputIndex;
}

export class UtxoIndex {
  /** verifierKey -> Map<outputKey, UtxoEntry>. */
  private readonly index = new Map<string, Map<string, UtxoEntry>>();
  private readonly store: BlockStore;

  /**
   * Listeners for outputs that become spendable via a reorg (a block or
   * draft claiming the output becomes non-canonical) rather than via a
   * new canonical block. The "new canonical block" path is already
   * covered by DraftStrategy reacting to newly-canonical events, so the
   * hook only fires from the re-add paths below -- never from the
   * initial add of a block's own outputs.
   *
   * Use: `GenerationService` wakes blocked contracts waiting on the
   * output's verifier; without this hook a reorg that frees up the only
   * matching UTXO would leave the contract parked indefinitely.
   */
  private readonly _reAddListeners: (
    (blockHash: Hash, outputIndex: number) => void
  )[] = [];

  /**
   * Pending re-added outputs batched within a single canonicality flush.
   * Consensus fires non-canonical events BEFORE canonical ones within a
   * single `flushChanges`, so an output claimed by both a now-aggregated
   * block and its aggregator is transiently re-added and then immediately
   * removed again. Firing listeners synchronously would expose that
   * intermediate state. We defer firing to a microtask so observers see
   * only the settled set.
   */
  private _pendingReAdded: { blockHash: Hash; outputIndex: number }[] = [];
  private _flushScheduled = false;

  constructor(store: BlockStore) {
    this.store = store;
  }

  /**
   * Register a listener for outputs re-added to the index after being
   * claimed (i.e. made spendable again by a reorg). Fired on a microtask,
   * once the current canonicality batch has fully drained.
   */
  onOutputReAdded(cb: (blockHash: Hash, outputIndex: number) => void): void {
    this._reAddListeners.push(cb);
  }

  private _fireReAdded(blockHash: Hash, outputIndex: number): void {
    this._pendingReAdded.push({ blockHash, outputIndex });
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    queueMicrotask(() => this._flushPendingReAdded());
  }

  private _flushPendingReAdded(): void {
    this._flushScheduled = false;
    const pending = this._pendingReAdded;
    this._pendingReAdded = [];
    for (const { blockHash, outputIndex } of pending) {
      // Drop events whose output is no longer in the index -- i.e. a
      // subsequent canonical event already removed it. Only the settled
      // state is worth reporting.
      const block = this.store.get(blockHash);
      if (!block) continue;
      if (outputIndex >= block.outputs.length) continue;
      const output = block.outputs[outputIndex];
      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(blockHash, outputIndex);
      const entries = this.index.get(vKey);
      if (!entries || !entries.has(oKey)) continue;
      for (const cb of this._reAddListeners) cb(blockHash, outputIndex);
    }
  }

  /** Query all unspent outputs for a given verifier. */
  getByVerifier(contract: Hash, params: Uint8Array): UtxoEntry[] {
    const key = verifierKey(contract, params);
    const entries = this.index.get(key);
    if (!entries) return [];
    return [...entries.values()];
  }

  /** Same as `getByVerifier`, with a pre-computed verifier key string. */
  getByVerifierKey(key: string): UtxoEntry[] {
    const entries = this.index.get(key);
    if (!entries) return [];
    return [...entries.values()];
  }

  // -- Block-level canonicality ------------------------------------

  /** Called when a real block becomes canonical. */
  blockBecameCanonical(block: Block): void {
    this.addBlockOutputs(block);
    this.removeBlockClaimedOutputs(block);
  }

  /** Called when a real block becomes non-canonical. Reverses the above. */
  blockBecameNonCanonical(block: Block): void {
    this.removeBlockOutputs(block);
    this.reAddBlockClaimedOutputs(block);
  }

  // -- Draft-level canonicality ------------------------------------

  /**
   * Called when a draft becomes canonical. Removes each output in the
   * draft's `resolvedClaims` from the index -- these UTXOs are now
   * reserved for this (local-only, phantom) draft.
   *
   * Drafts do not produce UTXOs: their own outputs are not indexed,
   * since they become spendable only when the draft publishes as a real
   * block (at which point `blockBecameCanonical` adds them).
   */
  draftBecameCanonical(draft: BlockDraft): void {
    this.removeDraftClaimedOutputs(draft);
  }

  /**
   * Called when a draft becomes non-canonical. Re-adds the outputs its
   * `resolvedClaims` had reserved.
   */
  draftBecameNonCanonical(draft: BlockDraft): void {
    this.reAddDraftClaimedOutputs(draft);
  }

  // -- Internal: block path ----------------------------------------

  private addBlockOutputs(block: Block): void {
    for (let i = 0; i < block.outputs.length; i++) {
      const output = block.outputs[i];
      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(block.hash, i);

      let entries = this.index.get(vKey);
      if (!entries) {
        entries = new Map();
        this.index.set(vKey, entries);
      }
      entries.set(oKey, {
        blockHash: block.hash,
        outputIndex: i,
        value: output.value,
        extendedIndex: i,
      });
    }
  }

  private removeBlockOutputs(block: Block): void {
    for (let i = 0; i < block.outputs.length; i++) {
      const output = block.outputs[i];
      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(block.hash, i);

      const entries = this.index.get(vKey);
      if (entries) {
        entries.delete(oKey);
        if (entries.size === 0) this.index.delete(vKey);
      }
    }
  }

  /**
   * Remove outputs a real block claims via its index-based `claims: Index[]`
   * (walking the anchor's extended output vector).
   */
  private removeBlockClaimedOutputs(block: Block): void {
    if (Hash.equals(block.anchor, ZERO_HASH)) return;
    if (block.claims.length === 0) return;

    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return;

    const anchorExtended = collectExtendedOutputs(anchorBlock, this.store);
    const anchorExtendedSources = this.resolveExtendedSources(anchorBlock);
    const ownOutputCount = block.outputs.length;

    for (const claimIdx of block.claims) {
      if (claimIdx < ownOutputCount) continue; // self-claim
      const extIdx = claimIdx - ownOutputCount;
      if (extIdx >= anchorExtended.length) continue;

      const output = anchorExtended[extIdx];
      const source = anchorExtendedSources[extIdx];
      if (!source) continue;

      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(source.blockHash, source.outputIndex);
      const entries = this.index.get(vKey);
      if (entries) {
        entries.delete(oKey);
        if (entries.size === 0) this.index.delete(vKey);
      }
    }
  }

  /** Re-add outputs a non-canonical block had claimed via index-based claims. */
  private reAddBlockClaimedOutputs(block: Block): void {
    if (Hash.equals(block.anchor, ZERO_HASH)) return;
    if (block.claims.length === 0) return;

    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return;

    const anchorExtended = collectExtendedOutputs(anchorBlock, this.store);
    const anchorExtendedSources = this.resolveExtendedSources(anchorBlock);
    const ownOutputCount = block.outputs.length;

    for (const claimIdx of block.claims) {
      if (claimIdx < ownOutputCount) continue;
      const extIdx = claimIdx - ownOutputCount;
      if (extIdx >= anchorExtended.length) continue;

      const output = anchorExtended[extIdx];
      const source = anchorExtendedSources[extIdx];
      if (!source) continue;

      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(source.blockHash, source.outputIndex);
      let entries = this.index.get(vKey);
      if (!entries) {
        entries = new Map();
        this.index.set(vKey, entries);
      }
      entries.set(oKey, {
        blockHash: source.blockHash,
        outputIndex: source.outputIndex,
        value: output.value,
        extendedIndex: extIdx,
      });
      this._fireReAdded(source.blockHash, source.outputIndex);
    }
  }

  /**
   * Remove a single `{blockHash, outputIndex}` from the index. Used when
   * a canonical draft adopts an output mid-generation (not via its
   * initial `resolvedClaims`, so no `draftBecameCanonical` would fire).
   * Idempotent: if the entry is already removed, no-op.
   */
  removeSpentOutput(blockHash: Hash, outputIndex: number): void {
    const block = this.store.get(blockHash);
    if (!block) return;
    if (outputIndex >= block.outputs.length) return;
    const output = block.outputs[outputIndex];

    const vKey = verifierKey(output.verifier.contract, output.verifier.params);
    const oKey = outputKey(blockHash, outputIndex);
    const entries = this.index.get(vKey);
    if (entries) {
      entries.delete(oKey);
      if (entries.size === 0) this.index.delete(vKey);
    }
  }

  /**
   * Re-add a single `{blockHash, outputIndex}` to the index. Symmetric
   * counterpart to `removeSpentOutput`: used when a draft releases an
   * adopted-but-unconsumed output (e.g. on draft cancellation after
   * publishing, when the contract didn't need all pre-queued inputs).
   * Idempotent.
   */
  reAddUnspentOutput(blockHash: Hash, outputIndex: number): void {
    const block = this.store.get(blockHash);
    if (!block) return;
    if (outputIndex >= block.outputs.length) return;
    const output = block.outputs[outputIndex];

    const vKey = verifierKey(output.verifier.contract, output.verifier.params);
    const oKey = outputKey(blockHash, outputIndex);
    let entries = this.index.get(vKey);
    if (!entries) {
      entries = new Map();
      this.index.set(vKey, entries);
    }
    entries.set(oKey, {
      blockHash,
      outputIndex,
      value: output.value,
      extendedIndex: outputIndex,
    });
  }

  // -- Internal: draft path ----------------------------------------

  /**
   * Remove each `{block, outputIndex}` in the draft's `resolvedClaims`.
   * Resolved claims are direct references -- no extended-vector walk
   * needed.
   */
  private removeDraftClaimedOutputs(draft: BlockDraft): void {
    for (const rc of draft.resolvedClaims) {
      const producing = this.store.get(rc.block);
      if (!producing) continue;
      if (rc.outputIndex >= producing.outputs.length) continue;
      const output = producing.outputs[rc.outputIndex];

      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(rc.block, rc.outputIndex);
      const entries = this.index.get(vKey);
      if (entries) {
        entries.delete(oKey);
        if (entries.size === 0) this.index.delete(vKey);
      }
    }
  }

  /** Re-add outputs a non-canonical draft had reserved. */
  private reAddDraftClaimedOutputs(draft: BlockDraft): void {
    for (const rc of draft.resolvedClaims) {
      const producing = this.store.get(rc.block);
      if (!producing) continue;
      if (rc.outputIndex >= producing.outputs.length) continue;
      const output = producing.outputs[rc.outputIndex];

      const vKey = verifierKey(output.verifier.contract, output.verifier.params);
      const oKey = outputKey(rc.block, rc.outputIndex);
      let entries = this.index.get(vKey);
      if (!entries) {
        entries = new Map();
        this.index.set(vKey, entries);
      }
      entries.set(oKey, {
        blockHash: rc.block,
        outputIndex: rc.outputIndex,
        value: output.value,
        extendedIndex: rc.outputIndex,
      });
      this._fireReAdded(rc.block, rc.outputIndex);
    }
  }

  // -- Extended-vector source resolution ----------------------------

  private resolveExtendedSources(
    block: Block,
  ): ({ blockHash: Hash; outputIndex: number } | null)[] {
    return this.resolveExtendedSourcesInner(block);
  }

  private resolveExtendedSourcesInner(
    block: Block,
  ): ({ blockHash: Hash; outputIndex: number } | null)[] {
    const result: ({ blockHash: Hash; outputIndex: number } | null)[] = [];
    for (let i = 0; i < block.outputs.length; i++) {
      result.push({ blockHash: block.hash, outputIndex: i });
    }

    if (Hash.equals(block.anchor, ZERO_HASH)) return result;

    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return result;

    const anchorSources = this.resolveExtendedSourcesInner(anchorBlock);
    const anchorExtended = collectExtendedOutputs(anchorBlock, this.store);

    const ownOutputCount = block.outputs.length;
    const claimedExtIndices = new Set<number>();
    for (const claimIdx of block.claims) {
      if (claimIdx >= ownOutputCount) {
        claimedExtIndices.add(claimIdx - ownOutputCount);
      }
    }

    for (let i = 0; i < anchorExtended.length; i++) {
      if (!claimedExtIndices.has(i)) {
        result.push(i < anchorSources.length ? anchorSources[i] : null);
      }
    }

    return result;
  }
}
