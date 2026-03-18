import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Block, BlockStore } from '../core/Block.ts';
import { ResolvedClaim } from '../core/BlockDraft.ts';
import { BlockReceivedResult } from '../core/Coordinator.ts';
import { BlockSpec, Output } from '../core/BlockCreationModule.ts';
import { ConflictService } from '../core/ConflictService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { SamplingService } from '../core/SamplingService.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { Coordinator } from '../core/Coordinator.ts';

// -- Future types (placeholders until their modules exist) ----------

/** Opaque verifier key. */
export type VerifierKey = string;

/** Result of a fetch operation. */
export interface FetchResult {
  readonly block: Block;
  readonly data: Uint8Array;
}

// -- Reactive event and action types --------------------------------

/** Event passed to strategies for evaluation. */
export interface ReactiveEvent {
  readonly block: Block;
  readonly fromPeer: string | null;
  readonly result: BlockReceivedResult;
  readonly store: BlockStore;
  readonly consensus: ConsensusService;
  readonly conflict: ConflictService;
  readonly sampling: SamplingService;
}

/** Actions that strategies can request. */
export type Action =
  | { type: 'createBlock'; spec: BlockSpec; sign: boolean }
  | { type: 'verify'; block: Hash; contract: Hash; params: Uint8Array }
  | { type: 'dispute'; block: Hash; side: 'for' | 'against' }
  | { type: 'notifyFetch'; verifier: VerifierKey; result: FetchResult | null }
  | {
    type: 'createDraft';
    claim: ResolvedClaim;
    outputs: Output[];
    declaredWeight: number;
    anchor: Hash;
    refs?: Hash[];
    aggregates?: Hash[];
  };

// -- Block creator interface ----------------------------------------

/** A strategy evaluates reactive events and produces actions. */
export interface Strategy {
  evaluate(event: ReactiveEvent): Action[];
}

/**
 * Interface for creating blocks from specs.
 * The ReactiveLayer uses this to execute createBlock actions.
 * Pass a privateKey to sign the block, or null for unsigned.
 */
export interface BlockCreator {
  createBlock(spec: BlockSpec, privateKey: Uint8Array | null): Block | null;
}

// -- ReactiveLayer --------------------------------------------------

/**
 * The reactive layer sits between the network and the protocol coordinator.
 * It is the ONLY component that calls coordinator.blockReceived().
 *
 * For each incoming block:
 * 1. Passes the block through the coordinator
 * 2. Builds a ReactiveEvent from the result
 * 3. Evaluates all registered strategies
 * 4. Executes the resulting actions
 * 5. createBlock actions recurse through processBlock, with a recursion
 *    guard that prevents strategies from re-evaluating blocks they just created
 *    in the same top-level evaluation cycle.
 */
export class ReactiveLayer {
  private readonly coordinator: Coordinator;
  private readonly store: BlockStore;
  private readonly consensus: ConsensusService;
  private readonly conflict: ConflictService;
  private readonly sampling: SamplingService;
  private readonly strategies: Strategy[];
  private readonly blockCreator: BlockCreator;
  private readonly privateKey: Uint8Array | null;

  private readonly draftManager?: DraftManager;

  private readonly onNotifyFetch?: (verifier: VerifierKey, result: FetchResult | null) => void;
  private readonly onBlockProcessed?: (block: Block) => void;

  constructor(deps: {
    coordinator: Coordinator;
    store: BlockStore;
    consensus: ConsensusService;
    conflict: ConflictService;
    sampling: SamplingService;
    strategies: Strategy[];
    blockCreator: BlockCreator;
    privateKey?: Uint8Array | null;
    draftManager?: DraftManager;
    onNotifyFetch?: (verifier: VerifierKey, result: FetchResult | null) => void;
    onBlockProcessed?: (block: Block) => void;
  }) {
    this.coordinator = deps.coordinator;
    this.store = deps.store;
    this.consensus = deps.consensus;
    this.conflict = deps.conflict;
    this.sampling = deps.sampling;
    this.strategies = deps.strategies;
    this.blockCreator = deps.blockCreator;
    this.privateKey = deps.privateKey ?? null;
    this.draftManager = deps.draftManager;
    this.onNotifyFetch = deps.onNotifyFetch;
    this.onBlockProcessed = deps.onBlockProcessed;
  }

  /**
   * Process a received block through the coordinator and all strategies.
   *
   * Returns all actions collected during this evaluation cycle, including
   * actions from recursively created blocks.
   */
  processBlock(block: Block, fromPeer: string | null): ProcessBlockResult {
    const cycleCreated = new Set<HashPrimitive>();
    const allActions: Action[] = [];

    this.processBlockInner(block, fromPeer, cycleCreated, allActions);

    return { actions: allActions };
  }

  private processBlockInner(
    block: Block,
    fromPeer: string | null,
    cycleCreated: Set<HashPrimitive>,
    allActions: Action[],
  ): void {
    // 1. Run the block through the coordinator
    const result = this.coordinator.blockReceived(block, fromPeer);

    // Notify that block was processed (for BlockRecordSet)
    this.onBlockProcessed?.(block);

    // 2. Skip strategy evaluation for blocks created in this cycle
    if (cycleCreated.has(block.hash.toPrimitive())) {
      return;
    }

    // 3. Build the reactive event
    const event: ReactiveEvent = {
      block,
      fromPeer,
      result,
      store: this.store,
      consensus: this.consensus,
      conflict: this.conflict,
      sampling: this.sampling,
    };

    // 4. Evaluate all strategies and collect actions
    const actions: Action[] = [];
    for (const strategy of this.strategies) {
      const strategyActions = strategy.evaluate(event);
      actions.push(...strategyActions);
    }

    allActions.push(...actions);

    // 5. Execute actions
    for (const action of actions) {
      switch (action.type) {
        case 'createBlock': {
          const key = action.sign ? this.privateKey : null;
          const newBlock = this.blockCreator.createBlock(action.spec, key);
          if (newBlock) {
            // Mark as created in this cycle so strategies don't re-evaluate it
            cycleCreated.add(newBlock.hash.toPrimitive());
            // Recurse: process the new block through coordinator and strategies
            this.processBlockInner(newBlock, null, cycleCreated, allActions);
          }
          break;
        }
        case 'verify':
          // Async: started but does not block. Results come back as new blocks later.
          break;
        case 'dispute':
          // Async: started but does not block.
          break;
        case 'notifyFetch':
          if (this.onNotifyFetch) {
            this.onNotifyFetch(action.verifier, action.result);
          }
          break;
        case 'createDraft':
          if (this.draftManager) {
            this.draftManager.createDraft({
              resolvedClaims: [action.claim],
              outputs: action.outputs,
              declaredWeight: action.declaredWeight,
              anchor: action.anchor,
              refs: action.refs,
              aggregates: action.aggregates,
            });
          }
          break;
      }
    }
  }
}

/** Result of processBlock. */
export interface ProcessBlockResult {
  readonly actions: Action[];
}
