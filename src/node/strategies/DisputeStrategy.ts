import { Strategy, ReactiveEvent, Action } from '../ReactiveLayer.ts';
import { Hash, HashPrimitive } from '../../util/Hash.ts';

/** Configuration for the dispute strategy. */
export interface DisputeStrategyConfig {
  /** Whether dispute creation is enabled. Default: true */
  enabled?: boolean;
}

const DEFAULT_CONFIG: Required<DisputeStrategyConfig> = {
  enabled: true,
};

/**
 * Reactive strategy that creates dispute actions when invalid blocks are detected.
 *
 * Works in two phases:
 * 1. External callers (e.g., SamplingStrategy's verification pipeline) call
 *    reportInvalid(hash) when they detect fraud.
 * 2. On evaluate(), the strategy checks if any reported-invalid blocks are still
 *    canonical, and if we haven't already disputed them, returns a dispute action.
 *
 * Tracks disputed blocks in a Set to prevent duplicate disputes.
 */
export class DisputeStrategy implements Strategy {
  private readonly config: Required<DisputeStrategyConfig>;
  private readonly disputed: Set<HashPrimitive>;
  private readonly invalid: Set<HashPrimitive>;

  constructor(config?: DisputeStrategyConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.disputed = new Set();
    this.invalid = new Set();
  }

  evaluate(event: ReactiveEvent): Action[] {
    if (!this.config.enabled) {
      return [];
    }

    const actions: Action[] = [];

    // Get the current canonical view to check which invalid blocks are still canonical.
    const canonical = event.consensus.getCanonicalView();

    for (const hashPrimitive of this.invalid) {
      // Skip blocks we've already disputed.
      if (this.disputed.has(hashPrimitive)) {
        continue;
      }

      // Only dispute blocks that are currently canonical.
      if (!canonical.has(hashPrimitive)) {
        continue;
      }

      const blockHash = Hash.fromPrimitive(hashPrimitive);

      // Mark as disputed to prevent duplicate disputes.
      this.disputed.add(hashPrimitive);

      actions.push({
        type: 'dispute',
        block: blockHash,
        side: 'against',
      });
    }

    return actions;
  }

  /** Record that a verification failed for a block. */
  reportInvalid(blockHash: Hash): void {
    this.invalid.add(blockHash.toPrimitive());
  }

  /** Check if a block has been reported as invalid. */
  isInvalid(blockHash: Hash): boolean {
    return this.invalid.has(blockHash.toPrimitive());
  }
}
