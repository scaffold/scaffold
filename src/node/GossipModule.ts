// Protocol spec: docs/protocol/gossip.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { verifierKey as computeVerifierKey } from './UtxoIndex.ts';
import type { Verifier } from '../core/BlockCreationModule.ts';

// --- Types ---

/** Opaque string key for verifier identity ({contract}:{params} in hex). */
export type VerifierKey = string;

export { computeVerifierKey as verifierKey };

/** An entry in the subscription index. */
export interface SubscriptionEntry {
  readonly block: Hash;
  readonly outputIndex: number;
  readonly value: number;
}

/**
 * A directive to deliver a block toward a subscription source.
 * Emitted via onSendAction callback.
 */
export interface SendAction {
  /** The block to deliver. */
  readonly block: Hash;
  /** The subscription source block this responds to. */
  readonly trigger: Hash;
  /** The matching verifier key. */
  readonly verifier: VerifierKey;
  /** Value of the matched subscription output (for priority). */
  readonly amount: number;
}

// --- Provider ---

/** Output entry returned by the provider. */
export interface SubscribableOutput {
  readonly index: number;
  readonly verifierKey: VerifierKey;
  readonly value: number;
}

/** Resolved claim verifier entry returned by the provider. */
export interface ResolvedClaimVerifier {
  readonly verifierKey: VerifierKey;
  readonly value: number;
}

/**
 * Provider interface for the gossip module to access block output/claim data.
 * The module does not inspect blocks directly -- all data flows through this.
 */
export interface GossipProvider {
  /**
   * Returns non-self-claimed outputs for a block.
   * Each entry has the output index, verifier key, and value.
   */
  getSubscribableOutputs(block: Hash): SubscribableOutput[];

  /**
   * Returns the verifier key for each resolved claim on this block.
   * Uses block.resolvedClaims directly. May return incomplete results
   * if some claims haven't resolved yet; deferred resolutions are
   * handled via notifyClaimResolved.
   */
  getResolvedClaimVerifiers(block: Hash): ResolvedClaimVerifier[];
}

// --- Module ---

/**
 * The gossip module determines which blocks are relevant to which
 * subscriptions. Its mechanism is verifier-based subscriptions: blocks
 * with unclaimed outputs create implicit subscriptions, and new blocks
 * that match those subscriptions generate send actions.
 *
 * This module is the "what to send" layer. It has no knowledge of peers,
 * bandwidth, or network topology. The routing module handles delivery.
 *
 * Fully self-contained -- depends only on GossipProvider and Hash.
 */
export class GossipModule {
  private readonly provider: GossipProvider;

  /**
   * Subscription index: verifierKey -> Map<entryKey, SubscriptionEntry>
   * where entryKey is "blockHash:outputIndex".
   */
  private readonly index = new Map<VerifierKey, Map<string, SubscriptionEntry>>();

  /** Set of blocks that have been added as subscription sources (dedup). */
  private readonly subscribedBlocks = new Set<HashPrimitive>();

  /** Set of blocks that have been processed by blockReceived (dedup). */
  private readonly processedBlocks = new Set<HashPrimitive>();

  private readonly sendActionListeners: ((action: SendAction) => void)[] = [];

  constructor(provider: GossipProvider) {
    this.provider = provider;
  }

  // -- Listener Registration ----------------------------------------

  /**
   * Register a callback for send actions.
   * Called whenever the module determines a block should be delivered
   * toward a subscription source.
   */
  onSendAction(cb: (action: SendAction) => void): void {
    this.sendActionListeners.push(cb);
  }

  // -- Block Events -------------------------------------------------

  /**
   * Process a new block against the subscription index.
   *
   * For each of B's outputs with verifier V in the index:
   *   emit SendAction(block=B, trigger=A) for each subscriber A.
   *
   * For each of B's resolved claims with verifier V in the index:
   *   emit SendAction(block=B, trigger=A) for each subscriber A,
   *   then remove the claimed output from the index.
   *
   * Does NOT add B to the subscription index -- that's addSubscriptionSource.
   */
  blockReceived(block: Hash): void {
    const key = block.toPrimitive();
    if (this.processedBlocks.has(key)) return;
    this.processedBlocks.add(key);

    // Match outputs against existing subscriptions
    const outputs = this.provider.getSubscribableOutputs(block);
    for (const output of outputs) {
      const subscribers = this.index.get(output.verifierKey);
      if (!subscribers) continue;
      for (const entry of subscribers.values()) {
        this.emit({
          block,
          trigger: entry.block,
          verifier: output.verifierKey,
          amount: entry.value,
        });
      }
    }

    // Match claims against existing subscriptions and expire claimed outputs
    const claimVerifiers = this.provider.getResolvedClaimVerifiers(block);
    for (const cv of claimVerifiers) {
      const subscribers = this.index.get(cv.verifierKey);
      if (!subscribers) continue;
      for (const entry of subscribers.values()) {
        this.emit({
          block,
          trigger: entry.block,
          verifier: cv.verifierKey,
          amount: entry.value,
        });
      }
    }
  }

  /**
   * Add a block's unclaimed outputs to the subscription index.
   *
   * For each new V subscription, emits backfill send actions: existing
   * V content is pushed toward this block's subscriber path, and this
   * block's V outputs are pushed toward existing V subscribers.
   */
  addSubscriptionSource(block: Hash): void {
    const key = block.toPrimitive();
    if (this.subscribedBlocks.has(key)) return;
    this.subscribedBlocks.add(key);

    const outputs = this.provider.getSubscribableOutputs(block);

    for (const output of outputs) {
      const entryKey = entryKeyFor(block, output.index);
      const entry: SubscriptionEntry = {
        block,
        outputIndex: output.index,
        value: output.value,
      };

      // Snapshot existing entries BEFORE adding (the Map is mutable)
      const bucket = this.index.get(output.verifierKey);
      const existingEntries = bucket ? [...bucket.values()] : [];

      // Add to index
      let target = bucket;
      if (!target) {
        target = new Map();
        this.index.set(output.verifierKey, target);
      }
      target.set(entryKey, entry);

      // Backfill: push existing V content toward new subscriber
      if (existingEntries.length > 0) {
        for (const existing of existingEntries) {
          // Push existing block to new subscriber's path
          this.emit({
            block: existing.block,
            trigger: block,
            verifier: output.verifierKey,
            amount: output.value,
          });
          // Push new block to existing subscriber's path
          this.emit({
            block,
            trigger: existing.block,
            verifier: output.verifierKey,
            amount: existing.value,
          });
        }
      }
    }
  }

  // -- Subscription Lifecycle ---------------------------------------

  /**
   * Remove a specific output from the subscription index.
   * Called when an output is claimed by a canonical block.
   */
  outputClaimed(block: Hash, outputIndex: number): void {
    const outputs = this.provider.getSubscribableOutputs(block);
    const output = outputs.find((o) => o.index === outputIndex);
    if (!output) return;

    const bucket = this.index.get(output.verifierKey);
    if (!bucket) return;
    bucket.delete(entryKeyFor(block, outputIndex));
    if (bucket.size === 0) this.index.delete(output.verifierKey);
  }

  /**
   * Re-add a specific output to the subscription index.
   * Called when a claim is reversed due to canonical state change.
   */
  outputUnclaimed(block: Hash, outputIndex: number): void {
    const outputs = this.provider.getSubscribableOutputs(block);
    const output = outputs.find((o) => o.index === outputIndex);
    if (!output) return;

    let bucket = this.index.get(output.verifierKey);
    if (!bucket) {
      bucket = new Map();
      this.index.set(output.verifierKey, bucket);
    }

    const ek = entryKeyFor(block, outputIndex);
    if (!bucket.has(ek)) {
      bucket.set(ek, {
        block,
        outputIndex,
        value: output.value,
      });
    }
  }

  /**
   * Handle a deferred claim resolution.
   * Called when OutputClaimModule.onResolution fires for a claim that
   * wasn't resolvable when the block first arrived. Checks the verifier
   * against the subscription index and emits send actions via callback.
   */
  notifyClaimResolved(
    claimant: Hash,
    verifier: VerifierKey,
    _value: number,
  ): void {
    const subscribers = this.index.get(verifier);
    if (!subscribers) return;
    for (const entry of subscribers.values()) {
      this.emit({
        block: claimant,
        trigger: entry.block,
        verifier,
        amount: entry.value,
      });
    }
  }

  // -- Queries (for testing/debugging) ------------------------------

  /** Number of subscription entries for a verifier. */
  getSubscriptionCount(verifier: VerifierKey): number {
    return this.index.get(verifier)?.size ?? 0;
  }

  /** All subscription entries for a verifier. */
  getSubscriptionEntries(verifier: VerifierKey): SubscriptionEntry[] {
    const bucket = this.index.get(verifier);
    if (!bucket) return [];
    return [...bucket.values()];
  }

  /** Total number of active subscriptions across all verifiers. */
  get totalSubscriptionCount(): number {
    let total = 0;
    for (const bucket of this.index.values()) {
      total += bucket.size;
    }
    return total;
  }

  // -- Internals ----------------------------------------------------

  private emit(action: SendAction): void {
    for (const cb of this.sendActionListeners) {
      cb(action);
    }
  }
}

// --- Utilities ---

function entryKeyFor(block: Hash, outputIndex: number): string {
  return `${block.toPrimitive()}:${outputIndex}`;
}
