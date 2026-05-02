// Protocol spec: docs/protocol/output-claims.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import { mapSurvivingToOriginal } from './OutputSpace.ts';

// -- Types --------------------------------------------------------

/**
 * A resolved claim -- identifies which block and output index a claim
 * migrated to. Emitted by OutputClaimModule when a claim reaches its
 * producing block. Does not carry economic value; consumers look up
 * the output directly if they need it.
 */
export interface ClaimResolution {
  /** Hash of the block containing the claimed output. */
  readonly block: Hash;
  /** Index into that block's output array. */
  readonly outputIndex: number;
  /** Index into the claimant's claims[] array that this resolution was for. */
  readonly claimIndex: number;
}

/** A record of a block claiming an output. */
export interface OutputClaimEntry {
  /** Hash of the claiming block (or draftId for drafts). */
  readonly claimant: Hash;
  /** Index into the claimant's claims[] array. */
  readonly claimIndex: number;
}

/**
 * Provider interface for the output claim module to access block data.
 * The module is fully encapsulated -- it knows nothing about block
 * internals beyond what this interface exposes.
 */
export interface OutputClaimProvider<BlockType> {
  /** Return the block object for a given hash, or undefined if unknown. */
  getBlock(hash: Hash): BlockType | undefined;

  /** Return the hash of a block. */
  getHash(block: BlockType): Hash;

  /** Return the anchor hash. ZERO_HASH for genesis. */
  getAnchor(block: BlockType): Hash;

  /** Return the number of outputs this block itself produces. */
  getOwnOutputCount(block: BlockType): number;

  /** Return the ordered list of aggregate hashes. */
  getAggregateHashes(block: BlockType): Hash[];

  /**
   * Return the per-aggregate output counts (from AggregationData).
   * Empty array for leaf blocks.
   */
  getAggregateOutputCounts(block: BlockType): number[];

  /** Return the subtree claim mask (sorted anchor output indices claimed by aggregates). Empty for leaf blocks. */
  getSubtreeClaimMask(block: BlockType): readonly number[];

  /**
   * Return the block's own claims as a sorted list of indices into the
   * block's extended vector. Used to translate an index in
   * `output_space(block)` (what a descendant's anchor-portion claim
   * indexes into) back to an index in `extended_vector(block)` (what
   * `tryMigrate` recurses on).
   */
  getOwnClaimMask(block: BlockType): readonly number[];
}

// -- Module -------------------------------------------------------

/**
 * The output claim module tracks which blocks claim each output in the DAG.
 *
 * Claims start on the claiming block itself (since claim indices refer to the
 * block's own output space) and migrate toward the block that actually produced
 * the output. Migration happens one hop at a time through the output space
 * hierarchy: own outputs -> aggregates (reverse order) -> anchor.
 *
 * Key invariant: outputs are added before claims are applied. A claim at
 * index I in block.claims refers to index I in the block's own output space
 * (pre-claim), not the anchor's.
 *
 * Fully self-contained -- depends only on OutputClaimProvider and Hash.
 */
export class OutputClaimModule<BlockType> {
  private readonly provider: OutputClaimProvider<BlockType>;

  /**
   * Per-block output claims: block hash -> (output index -> list of claim entries).
   * An entry at index I on block B means "someone claims output I of B's output space".
   */
  private readonly claims = new Map<HashPrimitive, Map<number, OutputClaimEntry[]>>();

  /**
   * Reverse index: unloaded hash -> set of block hashes that have stuck entries
   * waiting for that hash. Used to efficiently trigger migration when a block loads.
   */
  private readonly waitingFor = new Map<HashPrimitive, Set<HashPrimitive>>();

  private readonly conflictListeners: ((a: Hash, b: Hash) => void)[] = [];
  private readonly resolutionListeners: ((
    claimant: Hash,
    target: ClaimResolution,
  ) => void)[] = [];

  constructor(provider: OutputClaimProvider<BlockType>) {
    this.provider = provider;
  }

  /** Register a callback for conflict detection. Fires when two different blocks claim the same output. */
  onConflict(cb: (a: Hash, b: Hash) => void): void {
    this.conflictListeners.push(cb);
  }

  /**
   * Register a callback for claim resolution. Fires when a claim reaches its
   * producing block -- both for immediate resolutions (in addBlock) and
   * deferred resolutions (in onBlockLoaded when a stuck migration completes).
   */
  onResolution(cb: (claimant: Hash, target: ClaimResolution) => void): void {
    this.resolutionListeners.push(cb);
  }

  // -- Mutations --------------------------------------------------

  /**
   * Register a block's claims. Places each claim on the block's own
   * outputClaims and immediately attempts migration.
   * Returns any claims that resolved (reached their producing block).
   */
  addBlock(hash: Hash, claimIndices: number[]): ClaimResolution[] {
    const resolved: ClaimResolution[] = [];

    for (let i = 0; i < claimIndices.length; i++) {
      const entry: OutputClaimEntry = { claimant: hash, claimIndex: i };
      this.placeEntry(hash, claimIndices[i], entry);
      const result = this.tryMigrate(hash, claimIndices[i], entry);
      if (result) resolved.push(result);
    }

    return resolved;
  }

  /**
   * Notify the module that a block has been loaded into the store.
   * Triggers migration for any stuck entries waiting for this block.
   * Returns any claims that resolved during migration.
   */
  onBlockLoaded(hash: Hash): ClaimResolution[] {
    const resolved: ClaimResolution[] = [];
    const key = hash.toPrimitive();

    const waiters = this.waitingFor.get(key);
    if (!waiters) return resolved;

    // Copy the set since migration may modify it
    const waiterList = [...waiters];
    this.waitingFor.delete(key);

    for (const waiterKey of waiterList) {
      const waiterClaims = this.claims.get(waiterKey);
      if (!waiterClaims) continue;

      // Find entries on this waiter block that map to the newly loaded block
      const entriesToMigrate: { index: number; entry: OutputClaimEntry }[] = [];
      for (const [index, entries] of waiterClaims) {
        for (const entry of entries) {
          entriesToMigrate.push({ index, entry });
        }
      }

      // Attempt migration for each entry
      for (const { index, entry } of entriesToMigrate) {
        const result = this.tryMigrate(
          Hash.fromPrimitive(waiterKey),
          index,
          entry,
        );
        if (result) resolved.push(result);
      }
    }

    return resolved;
  }

  // -- Queries ----------------------------------------------------

  /** Get all output claim entries for a block. */
  getClaims(hash: Hash): ReadonlyMap<number, readonly OutputClaimEntry[]> | undefined {
    return this.claims.get(hash.toPrimitive());
  }

  /** Get claimants for a specific output index on a block. */
  getClaimantsAt(hash: Hash, outputIndex: number): readonly OutputClaimEntry[] | undefined {
    return this.claims.get(hash.toPrimitive())?.get(outputIndex);
  }

  /**
   * Directly place a claim entry on a target block's output.
   * Used by draft-based generation -- no migration needed since drafts
   * don't participate in the output space hierarchy.
   */
  addClaim(claimant: Hash, targetBlock: Hash, targetIndex: number): void {
    const entry: OutputClaimEntry = { claimant, claimIndex: -1 };
    this.placeEntry(targetBlock, targetIndex, entry);
  }

  /**
   * Remove all claim entries where the claimant matches the given hash.
   * Used when a draft is cancelled to release its claimed outputs.
   */
  removeClaims(claimant: Hash): void {
    for (const [blockKey, blockClaims] of this.claims) {
      for (const [index, entries] of blockClaims) {
        const remaining = entries.filter((e) => !Hash.equals(e.claimant, claimant));
        if (remaining.length === 0) {
          blockClaims.delete(index);
        } else if (remaining.length < entries.length) {
          blockClaims.set(index, remaining);
        }
      }
      if (blockClaims.size === 0) this.claims.delete(blockKey);
    }
  }

  // -- Internals --------------------------------------------------

  /**
   * Place an entry on a block's outputClaims at the given index.
   * Does not attempt migration.
   */
  private placeEntry(blockHash: Hash, index: number, entry: OutputClaimEntry): void {
    const key = blockHash.toPrimitive();
    let blockClaims = this.claims.get(key);
    if (!blockClaims) {
      blockClaims = new Map();
      this.claims.set(key, blockClaims);
    }

    let entries = blockClaims.get(index);
    if (!entries) {
      entries = [];
      blockClaims.set(index, entries);
    }

    entries.push(entry);

    // Conflict detection: if 2+ distinct claimants on this output, fire conflicts.
    // Drafts (claimIndex === -1) participate uniformly with published blocks --
    // two drafts claiming the same output conflict, as does a draft vs a block
    // or two blocks. Only self-conflicts (same claimant re-registered) are
    // filtered. See docs/protocol/draft-blocks.md#conflict-integration.
    if (entries.length > 1) {
      for (let i = 0; i < entries.length - 1; i++) {
        const existing = entries[i];
        if (!Hash.equals(existing.claimant, entry.claimant)) {
          for (const cb of this.conflictListeners) {
            cb(existing.claimant, entry.claimant);
          }
        }
      }
    }
  }

  /**
   * Remove an entry from a block's outputClaims at the given index.
   */
  private removeEntry(blockHash: Hash, index: number, entry: OutputClaimEntry): void {
    const key = blockHash.toPrimitive();
    const blockClaims = this.claims.get(key);
    if (!blockClaims) return;

    const entries = blockClaims.get(index);
    if (!entries) return;

    const idx = entries.findIndex(
      (e) =>
        Hash.equals(e.claimant, entry.claimant) &&
        e.claimIndex === entry.claimIndex,
    );
    if (idx !== -1) entries.splice(idx, 1);

    if (entries.length === 0) blockClaims.delete(index);
    if (blockClaims.size === 0) this.claims.delete(key);
  }

  /**
   * Attempt to migrate an entry from block B at index I toward the producing block.
   * Returns a ClaimResolution if the entry reached the producing block, undefined otherwise.
   */
  private tryMigrate(
    blockHash: Hash,
    index: number,
    entry: OutputClaimEntry,
  ): ClaimResolution | undefined {
    const block = this.provider.getBlock(blockHash);
    if (!block) return undefined;

    const ownOutputCount = this.provider.getOwnOutputCount(block);

    // Case 1: Resolved -- claim targets this block's own output
    if (index < ownOutputCount) {
      const resolved: ClaimResolution = {
        block: blockHash,
        outputIndex: index,
        claimIndex: entry.claimIndex,
      };
      for (const cb of this.resolutionListeners) {
        cb(entry.claimant, resolved);
      }
      return resolved;
    }

    // Case 2: Descend through aggregates or to anchor
    const aggregateHashes = this.provider.getAggregateHashes(block);
    const aggregateOutputCounts = this.provider.getAggregateOutputCounts(block);

    let remaining = index - ownOutputCount;

    // Walk aggregates in reverse order
    for (let i = aggregateHashes.length - 1; i >= 0; i--) {
      const count = aggregateOutputCounts[i];
      if (remaining < count) {
        // `remaining` is an index in aggregate's output_space (the
        // post-claim survivor list). Recursing into the aggregate's
        // tryMigrate interprets the index in aggregate's extended
        // vector, so map output_space → extended_vector via the
        // aggregate's own claims. Without this the descent skips over
        // self-claims and misattributes the claim downstream.
        const aggHash = aggregateHashes[i];
        const aggBlock = this.provider.getBlock(aggHash);
        const aggExtIdx = aggBlock
          ? mapSurvivingToOriginal(remaining, this.provider.getOwnClaimMask(aggBlock))
          : remaining;
        return this.migrateEntry(blockHash, index, entry, aggHash, aggExtIdx);
      }
      remaining -= count;
    }

    const anchorHash = this.provider.getAnchor(block);
    if (Hash.equals(anchorHash, ZERO_HASH)) {
      return undefined;
    }

    // Map through subtree claim mask for aggregation blocks.
    // For leaf blocks (empty mask), remaining maps directly.
    const subtreeClaimMask = this.provider.getSubtreeClaimMask(block);
    const anchorSpaceIdx = subtreeClaimMask.length > 0
      ? mapSurvivingToOriginal(remaining, subtreeClaimMask)
      : remaining;

    // `anchorSpaceIdx` is an index into output_space(anchor). To
    // recurse into anchor's tryMigrate (which interprets indices in
    // anchor's extended_vector), apply anchor's own claims to map
    // output_space → extended_vector. Without this, a descendant's
    // claim that should resolve to an anchor's surviving output gets
    // misattributed to whichever extended-vector slot happens to share
    // its post-claim numeric index, e.g. a chess move's GAME_STATE
    // claim resolves to the parent's self-claimed RECORD slot and
    // creates a phantom conflict.
    const anchorBlock = this.provider.getBlock(anchorHash);
    const anchorIdx = anchorBlock
      ? mapSurvivingToOriginal(anchorSpaceIdx, this.provider.getOwnClaimMask(anchorBlock))
      : anchorSpaceIdx;

    return this.migrateEntry(blockHash, index, entry, anchorHash, anchorIdx);
  }

  /**
   * Move an entry from sourceBlock to targetBlock at the new index.
   * If target is not loaded, register a waiter. Otherwise, recurse.
   */
  private migrateEntry(
    sourceHash: Hash,
    sourceIndex: number,
    entry: OutputClaimEntry,
    targetHash: Hash,
    targetIndex: number,
  ): ClaimResolution | undefined {
    const targetBlock = this.provider.getBlock(targetHash);

    if (!targetBlock) {
      // Target not loaded -- stay stuck, register a waiter
      const targetKey = targetHash.toPrimitive();
      let waiters = this.waitingFor.get(targetKey);
      if (!waiters) {
        waiters = new Set();
        this.waitingFor.set(targetKey, waiters);
      }
      waiters.add(sourceHash.toPrimitive());
      return undefined;
    }

    // Move the entry
    this.removeEntry(sourceHash, sourceIndex, entry);
    this.placeEntry(targetHash, targetIndex, entry);

    // Remove the source from waiting-for since we successfully migrated
    this.removeWaiter(targetHash, sourceHash);

    // Recurse
    return this.tryMigrate(targetHash, targetIndex, entry);
  }

  /** Remove a waiter registration. */
  private removeWaiter(targetHash: Hash, waiterHash: Hash): void {
    const targetKey = targetHash.toPrimitive();
    const waiters = this.waitingFor.get(targetKey);
    if (!waiters) return;
    waiters.delete(waiterHash.toPrimitive());
    if (waiters.size === 0) this.waitingFor.delete(targetKey);
  }
}
