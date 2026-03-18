import { Action, ReactiveEvent, Strategy } from '../ReactiveLayer.ts';
import { Hash, HashPrimitive } from '../../util/Hash.ts';
import { BlockSpec } from '../../core/BlockCreationModule.ts';
import { ZERO_HASH } from '../../util/Hash.ts';
import { makeAggregationOutput } from '../../core/Block.ts';

/** Configuration for the aggregation strategy. */
export interface AggregationStrategyConfig {
  /** Minimum leaves to trigger aggregation. Default: 2 */
  minLeaves?: number;
  /** Maximum children per aggregation. Default: 3 */
  maxChildren?: number;
}

const DEFAULT_CONFIG: Required<AggregationStrategyConfig> = {
  minLeaves: 2,
  maxChildren: 3,
};

/**
 * Reactive strategy that builds aggregation blocks when canonical leaf
 * blocks share an anchor.
 *
 * On each event:
 * 1. Checks for canonicality changes.
 * 2. Gets all canonical blocks from the store.
 * 3. Groups canonical leaf blocks (not aggregated by any other canonical
 *    block) by their anchor.
 * 4. For each anchor group with >= minLeaves blocks, emits a createBlock
 *    action with a BlockSpec that aggregates them.
 *
 * Includes a recursion guard: blocks created in the current cycle (tracked
 * by the ReactiveLayer's cycleCreated set) are skipped at the layer level.
 * The strategy itself avoids proposing aggregation of blocks that it just
 * proposed aggregating in a single evaluate call.
 */
export class AggregationStrategy implements Strategy {
  private readonly config: Required<AggregationStrategyConfig>;

  constructor(config?: AggregationStrategyConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluate(event: ReactiveEvent): Action[] {
    // Only react when there are canonicality changes.
    if (event.result.canonicalityChanges.length === 0) {
      return [];
    }

    const { store, consensus } = event;
    const canonicalView = consensus.getCanonicalView();

    // Group canonical leaf blocks by anchor.
    // A "leaf" is a canonical block that has not been aggregated by any
    // other block in the store.
    const byAnchor = new Map<HashPrimitive, Hash[]>();

    for (const key of canonicalView) {
      const hash = Hash.fromPrimitive(key);
      const block = store.get(hash);
      if (!block) continue;

      // Skip genesis blocks (anchor is ZERO_HASH).
      if (Hash.equals(block.anchor, ZERO_HASH)) continue;

      // Skip already-aggregated blocks.
      if (store.isAggregated(hash)) continue;

      const anchorKey = block.anchor.toPrimitive();
      let group = byAnchor.get(anchorKey);
      if (!group) {
        group = [];
        byAnchor.set(anchorKey, group);
      }
      group.push(hash);
    }

    // For each group meeting the threshold, produce a createBlock action.
    const actions: Action[] = [];

    for (const [anchorKey, hashes] of byAnchor) {
      if (hashes.length < this.config.minLeaves) continue;

      const toAggregate = hashes.slice(0, this.config.maxChildren);
      const anchorHash = Hash.fromPrimitive(anchorKey);

      const spec: BlockSpec = {
        anchor: anchorHash,
        outputs: [makeAggregationOutput()],
        claims: [],
        declaredWeight: 1,
        aggregates: toAggregate,
        refs: [],
      };

      actions.push({ type: 'createBlock', spec, sign: false });
    }

    return actions;
  }
}
