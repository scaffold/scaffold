import { Strategy, ReactiveEvent, Action } from '../ReactiveLayer.ts';
import { Hash, HashPrimitive } from '../../util/Hash.ts';
import { Block } from '../../core/Block.ts';
import { ContractExecutor } from '../ContractExecutor.ts';
import { BlockSpec } from '../../core/BlockCreationModule.ts';

export interface GenerationStrategyConfig {
  /** Maximum concurrent generations. Default: 3. */
  maxConcurrent?: number;
}

const DEFAULT_CONFIG: Required<GenerationStrategyConfig> = {
  maxConcurrent: 3,
};

/**
 * Reactive strategy that responds to newly canonical incentive blocks
 * by producing generation (response) blocks.
 *
 * An "incentive block" is any canonical block that has at least one output
 * whose contract hash is registered in the ContractExecutor.  When such a
 * block becomes canonical the strategy emits a `createBlock` action whose
 * spec anchors on the incentive block and carries the matched contract hash
 * as the output contract.
 *
 * Duplicate and concurrent generation is prevented via an in-flight set
 * bounded by `maxConcurrent`.
 */
export class GenerationStrategy implements Strategy {
  private readonly executor: ContractExecutor;
  private readonly config: Required<GenerationStrategyConfig>;
  private readonly inFlight: Set<HashPrimitive>;

  constructor(executor: ContractExecutor, config?: GenerationStrategyConfig) {
    this.executor = executor;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.inFlight = new Set();
  }

  evaluate(event: ReactiveEvent): Action[] {
    // Only react to canonicality changes.
    const newlyCanonical = event.result.canonicalityChanges.filter(
      (c) => c.canonical,
    );
    if (newlyCanonical.length === 0) {
      return [];
    }

    const actions: Action[] = [];

    for (const change of newlyCanonical) {
      // Respect concurrency limit.
      if (this.inFlight.size >= this.config.maxConcurrent) {
        break;
      }

      const key = change.hash.toPrimitive();

      // Skip blocks already being generated.
      if (this.inFlight.has(key)) {
        continue;
      }

      // Look up the block in the store.
      const block = event.store.get(change.hash);
      if (!block) {
        continue;
      }

      // Determine if this is an incentive block: at least one output whose
      // contract hash is registered in the executor.
      const matchedOutput = block.outputs.find((out) =>
        this.executor.hasContract(out.contract),
      );
      if (!matchedOutput) {
        continue;
      }

      // Mark in-flight.
      this.inFlight.add(key);

      // Build a generation spec that anchors on the incentive block.
      const spec: BlockSpec = {
        anchor: block.hash,
        outputs: [
          {
            contract: matchedOutput.contract,
            value: 0,
            data: new Uint8Array(),
          },
        ],
        claims: [],
        declaredWeight: 1,
        aggregates: [],
      };

      actions.push({ type: 'createBlock', spec, sign: true });
    }

    return actions;
  }

  /** Mark a generation as complete, freeing a concurrency slot. */
  completeGeneration(blockHash: Hash): void {
    this.inFlight.delete(blockHash.toPrimitive());
  }

  /** Number of generations currently in-flight. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }
}
