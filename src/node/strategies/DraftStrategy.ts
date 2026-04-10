import { Hash } from '../../util/Hash.ts';
import { BlockStore } from '../../core/Block.ts';
import { makeAggregationOutput } from '../../core/AggregationContract.ts';
import { ResolvedClaim } from '../../core/BlockDraft.ts';
import { Output } from '../../core/BlockCreationModule.ts';
import { ConsensusService } from '../../core/ConsensusService.ts';
import { ContractGenerator } from '../../core/ContractGenerator.ts';
import { Action, ReactiveEvent, Strategy } from '../ReactiveLayer.ts';

/** Action type for creating a draft (handled by ReactiveLayer). */
export interface CreateDraftAction {
  type: 'createDraft';
  claim: ResolvedClaim;
  outputs: Output[];
  declaredWeight: number;
  anchor: Hash;
  refs?: Hash[];
  aggregates?: Hash[];
}

export interface DraftStrategyConfig {
  /** Minimum output value to trigger draft creation. Default: 0 (all outputs). */
  minValue?: number;
  /** Maximum concurrent drafts. Default: 3. */
  maxConcurrent?: number;
  /** Filter: should generation run for this contract hash? Default: all enabled. */
  enableGeneration?: (contractHash: Hash) => boolean;
}

const DEFAULT_CONFIG = {
  minValue: 0,
  maxConcurrent: 3,
};

/**
 * Strategy that creates drafts for unclaimed outputs on newly canonical blocks.
 *
 * Before creating a new draft, checks if a blocked generator can be
 * resumed for the output (via ContractGenerator.notifyNewOutput).
 * Resumed outputs are not double-drafted.
 */
export class DraftStrategy implements Strategy {
  private readonly config: { minValue: number; maxConcurrent: number };
  private readonly inFlight = new Set<string>();
  private readonly _contractGenerator?: ContractGenerator;
  private readonly _enableGeneration: (contractHash: Hash) => boolean;

  constructor(config?: DraftStrategyConfig, contractGenerator?: ContractGenerator) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._contractGenerator = contractGenerator;
    this._enableGeneration = config?.enableGeneration ?? (() => true);
  }

  evaluate(event: ReactiveEvent): (Action | CreateDraftAction)[] {
    const newlyCanonical = event.result.canonicalityChanges.filter(
      (c) => c.canonical,
    );
    if (newlyCanonical.length === 0) return [];

    // First pass: resume blocked generators (no concurrency limit --
    // resuming feeds an existing draft, doesn't create a new one).
    if (this._contractGenerator) {
      for (const change of newlyCanonical) {
        const block = event.store.get(change.hash);
        if (!block) continue;

        for (let i = 0; i < block.outputs.length; i++) {
          const output = block.outputs[i];
          const trackingKey = `${change.hash.toPrimitive()}:${i}`;
          if (this.inFlight.has(trackingKey)) continue;

          const resumed = this._contractGenerator.notifyNewOutput(
            change.hash,
            i,
            output,
          );
          if (resumed) {
            this.inFlight.add(trackingKey);
          }
        }
      }
    }

    // Second pass: create new drafts for remaining outputs (up to maxConcurrent).
    const actions: CreateDraftAction[] = [];

    for (const change of newlyCanonical) {
      if (this.inFlight.size >= this.config.maxConcurrent) break;

      const block = event.store.get(change.hash);
      if (!block) continue;

      for (let i = 0; i < block.outputs.length; i++) {
        if (this.inFlight.size >= this.config.maxConcurrent) break;

        const output = block.outputs[i];
        if (output.value < this.config.minValue) continue;
        if (!this._enableGeneration(output.verifier.contract)) continue;

        const trackingKey = `${change.hash.toPrimitive()}:${i}`;
        if (this.inFlight.has(trackingKey)) continue;

        this.inFlight.add(trackingKey);

        // Find canonical tip for anchor
        const anchor = findCanonicalTip(event.store, event.consensus);

        const claim: ResolvedClaim = {
          block: change.hash,
          outputIndex: i,
          value: output.value,
        };

        actions.push({
          type: 'createDraft',
          claim,
          outputs: [makeAggregationOutput()],
          declaredWeight: 1,
          anchor,
        });
      }
    }

    return actions;
  }

  /** Mark a tracking key as no longer in-flight. */
  complete(blockHash: Hash, outputIndex: number): void {
    this.inFlight.delete(`${blockHash.toPrimitive()}:${outputIndex}`);
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }
}

/** Find the deepest canonical block. Falls back to genesis-like behavior. */
function findCanonicalTip(store: BlockStore, consensus: ConsensusService): Hash {
  const canonical = consensus.getCanonicalView();
  let bestHash: Hash | undefined;
  let bestDepth = -1;

  for (const key of canonical) {
    const hash = Hash.fromPrimitive(key);
    const block = store.get(hash);
    if (!block) continue;

    // Walk anchor chain to compute depth
    let depth = 0;
    let cur = block.anchor;
    while (store.has(cur)) {
      depth++;
      const parent = store.get(cur);
      if (!parent) break;
      cur = parent.anchor;
    }

    if (depth > bestDepth) {
      bestDepth = depth;
      bestHash = hash;
    }
  }

  return bestHash ?? Hash.fromPrimitive([...canonical][0]);
}
