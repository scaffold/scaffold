/**
 * Incremental UTXO index keyed by verifier (contract + params).
 *
 * Maintains the set of unspent outputs across canonical blocks.
 * Generic -- not specific to SIGNATURE_CONTRACT. Any consumer can query
 * by {contract, params} to find unspent outputs for that verifier.
 *
 * Index maintenance is wired into canonical change callbacks:
 * - Block becomes canonical: add its outputs, remove outputs it claims.
 * - Block becomes non-canonical: reverse (remove its outputs, re-add claimed).
 */

import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import { Block, BlockStore, collectExtendedOutputs } from '../core/Block.ts';

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
   * Used to compute claim indices for blocks anchored to blockHash's anchor chain.
   * For outputs of the genesis block, this equals outputIndex.
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
  /**
   * Map: verifierKey -> Map<outputKey, UtxoEntry>
   */
  private readonly index = new Map<string, Map<string, UtxoEntry>>();

  private readonly store: BlockStore;

  constructor(store: BlockStore) {
    this.store = store;
  }

  /** Query all unspent outputs for a given verifier. */
  getByVerifier(contract: Hash, params: Uint8Array): UtxoEntry[] {
    const key = verifierKey(contract, params);
    const entries = this.index.get(key);
    if (!entries) return [];
    return [...entries.values()];
  }

  /** Called when a block becomes canonical. */
  blockBecameCanonical(block: Block): void {
    // 1. Add this block's own outputs to the index
    this.addBlockOutputs(block);

    // 2. Remove outputs claimed by this block
    this.removeClaimedOutputs(block);
  }

  /** Called when a block becomes non-canonical. Reverses the above. */
  blockBecameNonCanonical(block: Block): void {
    // 1. Remove this block's own outputs from the index
    this.removeBlockOutputs(block);

    // 2. Re-add outputs that this block had claimed
    this.reAddClaimedOutputs(block);
  }

  /** Add a block's outputs to the index. */
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

      // Compute extendedIndex: for blocks anchored to this block's parent,
      // this output appears at index i in the block's own outputs, which
      // maps to index i in the extended vector of the parent chain.
      // For the consuming block, claim index = ownOutputs.length + extendedIndex.
      // We store the position within the extended vector of the block itself.
      entries.set(oKey, {
        blockHash: block.hash,
        outputIndex: i,
        value: output.value,
        extendedIndex: i,
      });
    }
  }

  /** Remove a block's outputs from the index. */
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
   * Remove outputs claimed by a block.
   * Claims with index >= block.outputs.length target the anchor's extended vector.
   */
  private removeClaimedOutputs(block: Block): void {
    if (Hash.equals(block.anchor, ZERO_HASH)) return; // genesis
    if (block.claims.length === 0) return;

    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return;

    // Collect the extended outputs of the anchor to resolve claim targets
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

  /**
   * Re-add outputs that were claimed by a now-non-canonical block.
   */
  private reAddClaimedOutputs(block: Block): void {
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
    }
  }

  /**
   * Resolve which original (blockHash, outputIndex) each position in the
   * extended output vector maps to. Walks the anchor chain.
   */
  private resolveExtendedSources(
    block: Block,
  ): ({ blockHash: Hash; outputIndex: number } | null)[] {
    return this.resolveExtendedSourcesInner(block);
  }

  private resolveExtendedSourcesInner(
    block: Block,
  ): ({ blockHash: Hash; outputIndex: number } | null)[] {
    // Own outputs
    const result: ({ blockHash: Hash; outputIndex: number } | null)[] = [];
    for (let i = 0; i < block.outputs.length; i++) {
      result.push({ blockHash: block.hash, outputIndex: i });
    }

    if (Hash.equals(block.anchor, ZERO_HASH)) return result;

    const anchorBlock = this.store.get(block.anchor);
    if (!anchorBlock) return result;

    const anchorSources = this.resolveExtendedSourcesInner(anchorBlock);
    const anchorExtended = collectExtendedOutputs(anchorBlock, this.store);

    // Build claim mask to identify surviving outputs
    const ownOutputCount = block.outputs.length;
    const claimedExtIndices = new Set<number>();
    for (const claimIdx of block.claims) {
      if (claimIdx >= ownOutputCount) {
        claimedExtIndices.add(claimIdx - ownOutputCount);
      }
    }

    // Add surviving anchor outputs (not claimed by this block)
    for (let i = 0; i < anchorExtended.length; i++) {
      if (!claimedExtIndices.has(i)) {
        result.push(i < anchorSources.length ? anchorSources[i] : null);
      }
    }

    return result;
  }
}
