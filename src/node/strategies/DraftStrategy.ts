import { Hash } from '../../util/Hash.ts';
import { BlockStore } from '../../core/Block.ts';
import { makeAggregationOutput } from '../../contracts/AggregationContract.ts';
import { ClaimIntent } from '../../core/Draft.ts';
import { Output } from '../../core/BlockCreationModule.ts';
import { ConsensusService } from '../../core/ConsensusService.ts';
import { Action, ReactiveEvent, Strategy } from '../ReactiveLayer.ts';

/**
 * Minimal interface DraftStrategy needs from the generation layer.
 *
 * `notifyNewOutput` absorbs a fresh UTXO into an existing generation if
 * possible (wake blocked, or adopt into an active draft). It returns
 * `true` iff the output is absorbed; `false` means no generation knows
 * about it yet.
 *
 * `hasActiveGenerationFor` lets the strategy skip creating a new draft
 * when one already exists for the same target (necessary to serialize
 * queue-dispatched generations for contracts like aggregation that
 * share a pool of inputs).
 */
export interface BlockedGeneratorNotifier {
  notifyNewOutput(blockHash: Hash, outputIndex: number, output: Output): boolean;
  hasActiveGenerationFor?(verifier: { contract: Hash; params: Uint8Array }): boolean;
}

/** Action type for creating a draft (handled by ReactiveLayer). */
export interface CreateDraftAction {
  type: 'createDraft';
  claim: ClaimIntent;
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
 * Optional UtxoIndex hook used to release stale `inFlight` entries when
 * the seed output has been spent by a published canonical block.
 */
export interface InFlightSweepIndex {
  isUnspent(blockHash: Hash, outputIndex: number): boolean;
}

/**
 * Strategy that creates drafts for unclaimed outputs on newly canonical blocks.
 *
 * Before creating a new draft, checks if a blocked generator can be
 * resumed for the output (via ContractGenerator.notifyNewOutput).
 * Resumed outputs are not double-drafted.
 */
export class DraftStrategy implements Strategy {
  private readonly config: { minValue: number; maxConcurrent: number };
  /**
   * Outputs that have been used to start a *new* draft (counts toward
   * `maxConcurrent`).
   */
  private readonly inFlight = new Set<string>();
  /**
   * Outputs absorbed into an existing generator via
   * `notifyNewOutput` — i.e. fed to a draft that already exists. These
   * don't count toward the new-draft cap; they only suppress
   * re-drafting the same seed.
   */
  private readonly resumed = new Set<string>();
  private readonly _notifier?: BlockedGeneratorNotifier;
  private readonly _enableGeneration: (contractHash: Hash) => boolean;
  private readonly _utxoIndex?: InFlightSweepIndex;

  constructor(
    config?: DraftStrategyConfig,
    notifier?: BlockedGeneratorNotifier,
    utxoIndex?: InFlightSweepIndex,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._notifier = notifier;
    this._enableGeneration = config?.enableGeneration ?? (() => true);
    this._utxoIndex = utxoIndex;
  }

  evaluate(event: ReactiveEvent): (Action | CreateDraftAction)[] {
    const newlyCanonical = event.result.canonicalityChanges.filter(
      (c) => c.canonical,
    );
    if (newlyCanonical.length === 0) return [];

    // Sweep stale inFlight entries: a tracking key is for a (block,
    // outputIndex) seed output that triggered draft creation. If the
    // output was claimed by a later canonical block (and thus removed
    // from the canonical UTXO view), the draft has long since published
    // and the entry should be released. Without this sweep, parked
    // drafts (chess GAME_STATE generators that wait on getOutput)
    // accumulate `inFlight` entries forever, eventually hitting
    // maxConcurrent and starving every new turn.
    // See docs/design/chess-turn-one-bug.md item 1.
    if (this._utxoIndex) {
      const sweep = (set: Set<string>) => {
        for (const key of [...set]) {
          const sep = key.lastIndexOf(':');
          if (sep < 0) continue;
          const blockKey = key.slice(0, sep);
          const outputIndex = Number(key.slice(sep + 1));
          const blockHash = Hash.fromPrimitive(blockKey);
          if (!this._utxoIndex!.isUnspent(blockHash, outputIndex)) {
            set.delete(key);
          }
        }
      };
      sweep(this.inFlight);
      sweep(this.resumed);
    }

    // First pass: resume blocked generators (no concurrency limit --
    // resuming feeds an existing draft, doesn't create a new one).
    if (this._notifier) {
      for (const change of newlyCanonical) {
        const block = event.store.get(change.hash);
        if (!block) continue;
        const selfClaimed = new Set(block.claimIndices.filter((c) => c < block.outputs.length));

        for (let i = 0; i < block.outputs.length; i++) {
          if (selfClaimed.has(i)) continue;
          const output = block.outputs[i];
          const trackingKey = `${change.hash.toPrimitive()}:${i}`;
          if (this.inFlight.has(trackingKey) || this.resumed.has(trackingKey)) continue;

          const resumed = this._notifier.notifyNewOutput(
            change.hash,
            i,
            output,
          );
          if (resumed) {
            this.resumed.add(trackingKey);
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
      const selfClaimed = new Set(block.claimIndices.filter((c) => c < block.outputs.length));

      for (let i = 0; i < block.outputs.length; i++) {
        if (this.inFlight.size >= this.config.maxConcurrent) break;

        if (selfClaimed.has(i)) continue;

        const output = block.outputs[i];
        if (output.value < this.config.minValue) continue;
        if (!this._enableGeneration(output.verifier.contract)) continue;

        // Skip if a generation is already running for this verifier.
        // Aggregation-style contracts share a UTXO pool; spawning a
        // second draft while the first is still running causes both to
        // grab a subset of the pool and deadlock.
        if (this._notifier?.hasActiveGenerationFor?.(output.verifier)) continue;

        const trackingKey = `${change.hash.toPrimitive()}:${i}`;
        if (this.inFlight.has(trackingKey) || this.resumed.has(trackingKey)) continue;

        this.inFlight.add(trackingKey);

        // Find canonical tip for anchor
        const anchor = findCanonicalTip(event.store, event.consensus);

        const claim: ClaimIntent = {
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
    const key = `${blockHash.toPrimitive()}:${outputIndex}`;
    this.inFlight.delete(key);
    this.resumed.delete(key);
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
