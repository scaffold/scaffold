import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Block, BlockStore } from '../core/Block.ts';
import { ClaimIntent } from '../core/BlockDraft.ts';
import { BlockReceivedResult } from '../core/Coordinator.ts';
import { BlockSpec, Output } from '../core/BlockCreationModule.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { SamplingService } from '../core/SamplingService.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { Coordinator } from '../core/Coordinator.ts';
import { RoutingService } from './RoutingService.ts';
import { PushAction } from './RoutingModule.ts';
import { ScopedLogger } from '../core/EventLog.ts';

// -- Reactive event and action types --------------------------------

/** Event passed to strategies for evaluation. */
export interface ReactiveEvent {
  readonly block: Block;
  readonly fromPeer: string | null;
  readonly result: BlockReceivedResult;
  readonly store: BlockStore;
  readonly consensus: ConsensusService;
  readonly sampling: SamplingService;
}

/** Actions that strategies can request. */
export type Action =
  | {
    type: 'createBlock';
    spec: BlockSpec;
    sign: boolean;
    /**
     * When false, build + sign + ingest locally but suppress the network
     * publish (no routing / push-action computation). Defaults to true.
     * Used by PiggybackStrategy to gate broadcast on local verification.
     */
    broadcast?: boolean;
    /**
     * Optional continuation called with the just-built block (or null on
     * build failure). Lets the emitting strategy track the produced
     * block hash for follow-up actions (e.g. submitBlock once verified).
     */
    onCreated?: (block: Block | null) => void;
  }
  | { type: 'submitBlock'; hash: Hash }
  | { type: 'verify'; block: Hash; contract: Hash; params: Uint8Array }
  | { type: 'dispute'; block: Hash; side: 'for' | 'against' }
  | {
    type: 'createDraft';
    claim: ClaimIntent;
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
  private readonly sampling: SamplingService;
  private readonly strategies: Strategy[];
  private readonly blockCreator: BlockCreator;
  private readonly privateKey: Uint8Array | null;

  private readonly routing?: RoutingService;
  private readonly draftManager?: DraftManager;
  private readonly _log?: ScopedLogger;

  private readonly onPushActions?: (actions: PushAction[], block: Block) => void;
  private readonly onBlockProcessed?: (block: Block) => void;

  /** Accumulated push actions from current block processing cycle. */
  private pendingPushActions: PushAction[] = [];

  constructor(deps: {
    coordinator: Coordinator;
    store: BlockStore;
    consensus: ConsensusService;
    sampling: SamplingService;
    strategies: Strategy[];
    blockCreator: BlockCreator;
    privateKey?: Uint8Array | null;
    routing?: RoutingService;
    draftManager?: DraftManager;
    logger?: ScopedLogger;
    onPushActions?: (actions: PushAction[], block: Block) => void;
    onBlockProcessed?: (block: Block) => void;
  }) {
    this.coordinator = deps.coordinator;
    this.store = deps.store;
    this.consensus = deps.consensus;
    this.sampling = deps.sampling;
    this.strategies = deps.strategies;
    this.blockCreator = deps.blockCreator;
    this.privateKey = deps.privateKey ?? null;
    this.routing = deps.routing;
    this.draftManager = deps.draftManager;
    this._log = deps.logger;
    this.onPushActions = deps.onPushActions;
    this.onBlockProcessed = deps.onBlockProcessed;

    // Register routing listener to accumulate push actions per block
    if (this.routing) {
      this.routing.onPushAction((action) => {
        this.pendingPushActions.push(action);
      });
    }
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
    broadcast: boolean = true,
  ): void {
    // 1. Run the block through the coordinator
    const result = this.coordinator.blockReceived(block, fromPeer);

    // 2. Routing: compute push targets (node-layer concern). Skipped when
    //    broadcast=false so locally-ingested piggyback blocks never touch
    //    the network until a follow-up `submitBlock` action graduates them.
    if (this.routing && broadcast) {
      this.pendingPushActions = [];
      this.routing.blockReceived(block.hash, fromPeer);
      if (this.pendingPushActions.length > 0) {
        this.onPushActions?.(this.pendingPushActions, block);
      }
    }

    // Notify that block was processed (for BlockRecordSet)
    this.onBlockProcessed?.(block);

    // 3. Skip strategy evaluation for blocks created in this cycle
    if (cycleCreated.has(block.hash.toPrimitive())) {
      return;
    }

    // 4. Build the reactive event
    const event: ReactiveEvent = {
      block,
      fromPeer,
      result,
      store: this.store,
      consensus: this.consensus,
      sampling: this.sampling,
    };

    // 5. Evaluate all strategies and collect actions
    const actions: Action[] = [];
    for (const strategy of this.strategies) {
      const strategyActions = strategy.evaluate(event);
      actions.push(...strategyActions);
    }

    if (actions.length > 0) {
      this._log?.debug('strategyActions', {
        hash: block.hash.toHex(),
        actions: actions.map((a) => a.type),
      });
    }

    allActions.push(...actions);

    // 6. Execute actions
    this._dispatchActions(actions, cycleCreated, allActions);
  }

  /**
   * Dispatch actions emitted outside the block-receive cycle. Used by
   * strategies that observe events from non-block sources (e.g.
   * PiggybackStrategy subscribing to `TrustGate.onTrustChanged`,
   * `UtxoIndex.onOutputReAdded`, or settled verification promises).
   *
   * Drives the same switch used by `processBlockInner`'s post-evaluate
   * step. createBlock actions still recurse through the block pipeline.
   */
  dispatchActions(actions: Action[]): void {
    if (actions.length === 0) return;
    this._log?.debug('externalActions', {
      actions: actions.map((a) => a.type),
    });
    const cycleCreated = new Set<HashPrimitive>();
    const allActions: Action[] = [];
    this._dispatchActions(actions, cycleCreated, allActions);
  }

  private _dispatchActions(
    actions: Action[],
    cycleCreated: Set<HashPrimitive>,
    allActions: Action[],
  ): void {
    for (const action of actions) {
      switch (action.type) {
        case 'createBlock': {
          const key = action.sign ? this.privateKey : null;
          const newBlock = this.blockCreator.createBlock(action.spec, key);
          if (newBlock) {
            this._log?.info('blockCreatedByStrategy', {
              hash: newBlock.hash.toHex(),
              anchor: action.spec.anchor.toHex(),
              outputCount: action.spec.outputs.length,
              broadcast: action.broadcast !== false,
            });
            // Mark as created in this cycle so strategies don't re-evaluate it
            cycleCreated.add(newBlock.hash.toPrimitive());
            // Recurse: process the new block through coordinator and strategies
            this.processBlockInner(
              newBlock,
              null,
              cycleCreated,
              allActions,
              action.broadcast !== false,
            );
          }
          action.onCreated?.(newBlock);
          break;
        }
        case 'submitBlock': {
          if (!this.routing) break;
          const stored = this.store.get(action.hash);
          if (!stored) {
            this._log?.warn('submitBlockUnknown', {
              hash: action.hash.toHex(),
            });
            break;
          }
          this.pendingPushActions = [];
          this.routing.blockReceived(stored.hash, null);
          if (this.pendingPushActions.length > 0) {
            this.onPushActions?.(this.pendingPushActions, stored);
          }
          this._log?.info('submitBlock', { hash: stored.hash.toHex() });
          break;
        }
        case 'verify':
          // Async: started but does not block. Results come back as new blocks later.
          break;
        case 'dispute':
          // Async: started but does not block.
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
