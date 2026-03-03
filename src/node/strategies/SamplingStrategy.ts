import { Strategy, ReactiveEvent, Action } from '../ReactiveLayer.ts';
import { Hash, HashPrimitive } from '../../util/Hash.ts';

/** Configuration for the sampling strategy. */
export interface SamplingStrategyConfig {
  /** Minimum priority threshold to trigger verification. Default: 0. */
  minPriority?: number;
  /** Maximum concurrent verifications. Default: 3. */
  maxConcurrent?: number;
}

const DEFAULT_CONFIG: Required<SamplingStrategyConfig> = {
  minPriority: 0,
  maxConcurrent: 3,
};

/**
 * Reactive strategy that decides which blocks to verify via sampling.
 *
 * On each event it checks for canonicality changes, queries the sampling module
 * for the highest-priority unverified block, and emits verify actions subject
 * to concurrency and priority thresholds.
 */
export class SamplingStrategy implements Strategy {
  private readonly config: Required<SamplingStrategyConfig>;
  private readonly inFlight: Set<HashPrimitive>;

  constructor(config?: SamplingStrategyConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.inFlight = new Set();
  }

  evaluate(event: ReactiveEvent): Action[] {
    // Only react when there are canonicality changes (new canonical blocks to verify).
    const hasNewCanonical = event.result.canonicalityChanges.some((c) => c.canonical);
    if (!hasNewCanonical) {
      return [];
    }

    const actions: Action[] = [];

    // Keep selecting the next highest-priority block until we hit our limits.
    // We use a loop because selectNext might return the same block or blocks
    // already in-flight; we collect candidates greedily.
    const considered = new Set<HashPrimitive>();

    while (this.inFlight.size < this.config.maxConcurrent) {
      const nextHash = event.sampling.selectNext();
      if (!nextHash) break;

      const key = nextHash.toPrimitive();

      // Avoid considering the same block twice in one evaluation.
      if (considered.has(key)) break;
      considered.add(key);

      // Skip blocks already being verified.
      if (this.inFlight.has(key)) continue;

      const priority = event.sampling.getPriority(nextHash);
      if (priority <= this.config.minPriority) break;

      const state = event.sampling.getState(nextHash);
      if (!state) continue;

      // Mark as in-flight immediately so subsequent loop iterations account for it.
      this.inFlight.add(key);

      // Record the sample request so the sampling module's priority updates.
      event.sampling.recordSampleRequested(nextHash);

      actions.push({
        type: 'verify',
        block: nextHash,
        contract: state.hash, // The tree root hash serves as the contract identifier.
        params: new Uint8Array(),
      });
    }

    return actions;
  }

  /** Mark a verification as complete, freeing a concurrency slot. */
  completeVerification(hash: Hash): void {
    this.inFlight.delete(hash.toPrimitive());
  }

  /** Number of verifications currently in-flight. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }
}
