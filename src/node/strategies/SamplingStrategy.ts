import { Action, ReactiveEvent, Strategy } from '../ReactiveLayer.ts';
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
 * Reactive strategy that decides which blocks to verify via probing.
 *
 * On each event it checks for canonicality changes, queries the sampling module
 * for the highest-priority unverified tree, initiates a sample descent, and
 * emits verify actions for the terminal block.
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

    // Keep selecting the next highest-priority tree until we hit our limits.
    const considered = new Set<HashPrimitive>();

    while (this.inFlight.size < this.config.maxConcurrent) {
      const nextHash = event.sampling.selectNext();
      if (!nextHash) break;

      const key = nextHash.toPrimitive();

      // Avoid considering the same tree twice in one evaluation.
      if (considered.has(key)) break;
      considered.add(key);

      // Skip trees already being verified.
      if (this.inFlight.has(key)) continue;

      const priority = event.sampling.getPriority(nextHash);
      if (priority <= this.config.minPriority) break;

      // Initiate a sample to find the terminal block
      const sampleResult = event.sampling.initSample(nextHash);
      if (!sampleResult.terminal) continue;

      const terminalHash = sampleResult.blockHash;
      this.inFlight.add(key);

      actions.push({
        type: 'verify',
        block: terminalHash,
        contract: nextHash, // tree root -- used for tracking
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
