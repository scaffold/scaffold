// Protocol spec: docs/protocol/gossip.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { verifierKey as computeVerifierKey } from './UtxoIndex.ts';

// --- Types ---

/** Opaque string key for verifier identity ({contract}:{params} in hex). */
export type VerifierKey = string;

export { computeVerifierKey as verifierKey };

/** An entry in the claim history index. */
export interface ClaimHistoryEntry {
  readonly block: Hash;
  readonly amount: number;
  readonly seq: number;
}

/**
 * A directive to deliver a block toward a claim history source.
 * Emitted via onSendAction callback.
 */
export interface SendAction {
  /** The block to deliver. */
  readonly block: Hash;
  /** The target block (routes toward this block's publisher path). */
  readonly trigger: Hash;
  /** The matching verifier key. */
  readonly verifier: VerifierKey;
  /** Value for priority computation. */
  readonly amount: number;
}

/** Configuration for claim history bounds. */
export interface GossipConfig {
  /** Maximum entries per verifier in claim history. */
  maxEntriesPerVerifier: number;
  /** Maximum entries per contract in fallback index. */
  maxEntriesPerContract: number;
}

export const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  maxEntriesPerVerifier: 64,
  maxEntriesPerContract: 128,
};

// --- Provider ---

/** Output entry returned by the provider. */
export interface BlockOutput {
  readonly index: number;
  readonly verifierKey: VerifierKey;
  readonly value: number;
}

/** An unclaimed output returned by the provider (for backfill). */
export interface UnclaimedOutput {
  readonly blockHash: Hash;
  readonly verifierKey: VerifierKey;
  readonly value: number;
}

/**
 * Provider interface for the gossip module.
 * The module does not inspect blocks directly -- all data flows through this.
 */
export interface GossipProvider {
  /**
   * Returns non-self-claimed outputs for a block.
   * Each entry has the output index, verifier key, and value.
   */
  getBlockOutputs(block: Hash): BlockOutput[];

  /**
   * Query unclaimed outputs for a given verifier key.
   * Used for backfill when new claim history entries appear.
   */
  getUnclaimedOutputs(verifierKey: VerifierKey): UnclaimedOutput[];
}

// --- Module ---

/**
 * The gossip module determines which blocks are relevant based on
 * claim history. Its mechanism is claim-history routing: blocks are
 * routed toward peers who have previously claimed outputs of matching
 * verifiers.
 *
 * Two rules:
 * - Rule 1 (via notifyClaimResolved): Route claims back toward their
 *   claimed output. Add to claim history. Backfill existing unclaimed
 *   outputs toward the new claimer.
 * - Rule 2 (via blockReceived): Route blocks with V outputs toward
 *   peers in V's claim history.
 *
 * Fully self-contained -- depends only on GossipProvider and Hash.
 */
export class GossipModule {
  private readonly provider: GossipProvider;
  private readonly config: GossipConfig;

  /** Claim history: verifierKey -> ClaimHistoryEntry[] (bounded). */
  private readonly claimHistory = new Map<VerifierKey, ClaimHistoryEntry[]>();

  /** Contract-level fallback: contractHashHex -> ClaimHistoryEntry[]. */
  private readonly contractFallback = new Map<string, ClaimHistoryEntry[]>();

  /** Monotonic sequence counter for recency ordering. */
  private seq = 0;

  /** Set of blocks that have been processed by blockReceived (dedup). */
  private readonly processedBlocks = new Set<HashPrimitive>();

  private readonly sendActionListeners: ((action: SendAction) => void)[] = [];

  constructor(provider: GossipProvider, config?: Partial<GossipConfig>) {
    this.provider = provider;
    this.config = { ...DEFAULT_GOSSIP_CONFIG, ...config };
  }

  // -- Listener Registration ----------------------------------------

  /**
   * Register a callback for send actions.
   * Called whenever the module determines a block should be delivered
   * toward a claim history source.
   */
  onSendAction(cb: (action: SendAction) => void): void {
    this.sendActionListeners.push(cb);
  }

  // -- Block Events -------------------------------------------------

  /**
   * Process a new block against the claim history index (Rule 2).
   *
   * For each of B's non-self-claimed outputs with verifier V:
   *   look up claimHistory[V] (with contract fallback)
   *   emit SendAction(block=B, trigger=entry.block) for each entry.
   *
   * Does NOT process claims or update claim history -- that happens
   * in notifyClaimResolved, which fires as claims resolve gradually
   * through OutputClaimModule.
   */
  blockReceived(block: Hash): void {
    const key = block.toPrimitive();
    if (this.processedBlocks.has(key)) return;
    this.processedBlocks.add(key);

    // Rule 2: match outputs against claim history
    const outputs = this.provider.getBlockOutputs(block);
    for (const output of outputs) {
      const entries = this.getClaimHistoryEntries(output.verifierKey);
      for (const entry of entries) {
        this.emit({
          block,
          trigger: entry.block,
          verifier: output.verifierKey,
          amount: entry.amount,
        });
      }
    }
  }

  // -- Claim Resolution ---------------------------------------------

  /**
   * Handle a resolved claim. This is the primary entry point for
   * Rule 1, claim history population, and backfill.
   *
   * Called when OutputClaimModule.onResolution fires -- both for
   * immediate resolutions (in addBlock) and deferred resolutions
   * (when stuck migrations complete). For network blocks, this is
   * the only path for claim processing (block.resolvedClaims is
   * undefined on network-received blocks).
   *
   * @param claimant - Hash of the block making the claim
   * @param verifier - Verifier key of the claimed output
   * @param value - Value of the claimed output
   * @param claimedBlock - Hash of the block whose output was claimed
   */
  notifyClaimResolved(
    claimant: Hash,
    verifier: VerifierKey,
    value: number,
    claimedBlock: Hash,
  ): void {
    // Rule 1: route the claiming block toward the claimed output
    this.emit({
      block: claimant,
      trigger: claimedBlock,
      verifier,
      amount: value,
    });

    // Add to claim history (with backfill)
    this.addClaimHistory(verifier, claimant, value);
  }

  // -- Queries (for testing/debugging) ------------------------------

  /** Number of claim history entries for a verifier (specific only). */
  getClaimHistoryCount(verifier: VerifierKey): number {
    return this.claimHistory.get(verifier)?.length ?? 0;
  }

  /** All claim history entries for a verifier (specific only, no fallback). */
  getClaimHistoryDirect(verifier: VerifierKey): readonly ClaimHistoryEntry[] {
    return this.claimHistory.get(verifier) ?? [];
  }

  /** Total claim history entries across all verifiers. */
  get totalClaimHistoryCount(): number {
    let total = 0;
    for (const entries of this.claimHistory.values()) {
      total += entries.length;
    }
    return total;
  }

  // -- Internals ----------------------------------------------------

  /**
   * Add an entry to the claim history and trigger backfill.
   * Appends to both verifier-specific and contract-level fallback indices.
   * Prunes if bounds exceeded.
   */
  private addClaimHistory(
    verifierKey: VerifierKey,
    block: Hash,
    amount: number,
  ): void {
    const entry: ClaimHistoryEntry = {
      block,
      amount,
      seq: this.seq++,
    };

    // Add to verifier-specific history
    let entries = this.claimHistory.get(verifierKey);
    if (!entries) {
      entries = [];
      this.claimHistory.set(verifierKey, entries);
    }
    entries.push(entry);
    this.pruneEntries(entries, this.config.maxEntriesPerVerifier);

    // Add to contract-level fallback
    const contractHash = extractContractHash(verifierKey);
    let fallback = this.contractFallback.get(contractHash);
    if (!fallback) {
      fallback = [];
      this.contractFallback.set(contractHash, fallback);
    }
    fallback.push(entry);
    this.pruneEntries(fallback, this.config.maxEntriesPerContract);

    // Backfill: route existing unclaimed V-output blocks toward new claimer
    const blockPrimitive = block.toPrimitive();
    const unclaimed = this.provider.getUnclaimedOutputs(verifierKey);
    for (const utxo of unclaimed) {
      // Skip self-referential backfill
      if (utxo.blockHash.toPrimitive() === blockPrimitive) continue;
      this.emit({
        block: utxo.blockHash,
        trigger: block,
        verifier: verifierKey,
        amount,
      });
    }
  }

  /**
   * Look up claim history entries for a verifier, with contract-level fallback.
   */
  private getClaimHistoryEntries(verifierKey: VerifierKey): ClaimHistoryEntry[] {
    const specific = this.claimHistory.get(verifierKey);
    if (specific && specific.length > 0) return specific;

    const contractHash = extractContractHash(verifierKey);
    return this.contractFallback.get(contractHash) ?? [];
  }

  /**
   * Prune entries in-place if they exceed maxSize.
   * Keeps highest-scoring entries by recency-weighted amount.
   */
  private pruneEntries(entries: ClaimHistoryEntry[], maxSize: number): void {
    if (entries.length <= maxSize) return;
    const currentSeq = this.seq;
    entries.sort((a, b) => {
      const scoreA = a.amount * (1 / (1 + (currentSeq - a.seq) / maxSize));
      const scoreB = b.amount * (1 / (1 + (currentSeq - b.seq) / maxSize));
      return scoreB - scoreA;
    });
    entries.length = maxSize;
  }

  private emit(action: SendAction): void {
    for (const cb of this.sendActionListeners) {
      cb(action);
    }
  }
}

// --- Utilities ---

/** Extract the contract hash portion of a verifier key (before the ':'). */
function extractContractHash(verifierKey: VerifierKey): string {
  const colonIdx = verifierKey.indexOf(':');
  return colonIdx >= 0 ? verifierKey.substring(0, colonIdx) : verifierKey;
}
