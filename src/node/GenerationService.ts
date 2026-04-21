// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import type { Output, Verifier } from '../core/BlockCreationModule.ts';
import { Block, BlockStore, collectExtendedOutputs } from '../core/Block.ts';
import {
  BlockDraft,
  ClaimIntent,
  DraftStore,
} from '../core/BlockDraft.ts';
import {
  type AvailableInput,
  type GeneratingEnvProvider,
} from '../core/ContractEnv.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { ExecutionQueueService } from '../core/ExecutionQueueService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { verifierKey as utxoVerifierKey } from './UtxoIndex.ts';
import { UtxoIndexService } from './UtxoIndexService.ts';
import { type WaitForInputFn } from '../core/GeneratingEnv.ts';
import type { GeneratorHandle, GeneratorProvider } from '../core/Generator.ts';
import {
  GenerationModule,
  type GenerationProvider,
  type GenerationSpec,
} from './GenerationModule.ts';

// -- GeneratingEnvAdapter -------------------------------------------

/**
 * Adapts BlockStore + UtxoIndex + OutputClaimService into a
 * `GeneratingEnvProvider<Block>`. Ported from the former
 * `ContractGenerator` with no behavior changes.
 */
class GeneratingEnvAdapter implements GeneratingEnvProvider<Block> {
  constructor(
    private readonly store: BlockStore,
    private readonly utxoIndex: UtxoIndexService,
    private readonly outputClaims: OutputClaimService,
  ) {}

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getOutputs(block: Block): Output[] {
    return block.outputs;
  }

  getClaims(block: Block): number[] {
    return block.claims;
  }

  getRefs(block: Block): Hash[] {
    return block.refs;
  }

  getExtendedOutputs(block: Block): Output[] {
    return collectExtendedOutputs(block, this.store);
  }

  findInputs(verifier: Verifier): AvailableInput[] {
    const entries = this.utxoIndex.getByVerifier(verifier.contract, verifier.params);
    const result: AvailableInput[] = [];
    for (const entry of entries) {
      const claimants = this.outputClaims.getClaimantsAt(entry.blockHash, entry.outputIndex);
      if (claimants && claimants.length > 0) continue;
      const block = this.store.get(entry.blockHash);
      if (!block || entry.outputIndex >= block.outputs.length) continue;
      const output = block.outputs[entry.outputIndex];
      result.push({
        verifier: output.verifier,
        value: output.value,
        data: output.data,
        isSelfClaim: false,
        block: entry.blockHash,
        outputIndex: entry.outputIndex,
      });
    }
    return result;
  }

  findBlockClaiming(verifier: Verifier): Hash | undefined {
    for (const block of this.store.values()) {
      if (Hash.equals(block.anchor, ZERO_HASH)) continue;
      const anchorBlock = this.store.get(block.anchor);
      if (!anchorBlock) continue;
      const anchorExtended = collectExtendedOutputs(anchorBlock, this.store);
      const ownOutputCount = block.outputs.length;
      for (const claimIdx of block.claims) {
        if (claimIdx < ownOutputCount) continue;
        const extIdx = claimIdx - ownOutputCount;
        if (extIdx >= anchorExtended.length) continue;
        const output = anchorExtended[extIdx];
        if (
          Hash.equals(output.verifier.contract, verifier.contract) &&
          bytesEqual(output.verifier.params, verifier.params)
        ) {
          return block.hash;
        }
      }
    }
    return undefined;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// -- Blocked-generator registry -------------------------------------

interface BlockedEntry {
  draftId: Hash;
  verifierKey: string;
  resolve: (input: AvailableInput) => void;
}

// -- Service --------------------------------------------------------

/**
 * Wires `GenerationModule` to:
 *   - `DraftManager`          -- draft creation, phantom-block consensus wiring
 *   - `ConsensusService`      -- canonicality events for restart triggering
 *   - `ExecutionQueueService` -- schedule the generation work
 *   - `ContractHostService`   -- actually run the contract in generation mode
 *   - `UtxoIndexService` + `OutputClaimService` -- source inputs and pre-claim them
 *
 * Also implements `GeneratorProvider` so `DraftManager` can invoke it as
 * the in-place replacement for the old `ContractGenerator`.
 *
 * Cancellation policy: none today. A draft that becomes uncanonical is kept
 * in the store at reduced priority; its Executable runs to completion. See
 * docs/protocol/execution-queue.md#deferred-preemption-and-cooperative-cancellation.
 */
export class GenerationService extends GenerationModule implements GeneratorProvider {
  private readonly _store: BlockStore;
  private readonly _draftStore: DraftStore;
  private readonly _consensus: ConsensusService;
  private readonly _queue: ExecutionQueueService;
  private readonly _host: ContractHostService;
  private readonly _outputClaims: OutputClaimService;
  private readonly _adapter: GeneratingEnvAdapter;
  /** Hook for draft cancellation. Set by NodeContext after construction. */
  private _cancelDraft: (draftId: Hash) => void = () => {};

  /** Blocked generators waiting for inputs, keyed by verifier. */
  private readonly _blocked = new Map<string, BlockedEntry[]>();

  /** Draft-level cancellation flags. Checked by the run loop. */
  private readonly _cancelled = new Set<HashPrimitive>();

  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const draftStore = ctx.get(DraftStore);
    const consensus = ctx.get(ConsensusService);
    const queue = ctx.get(ExecutionQueueService);
    const host = ctx.get(ContractHostService);
    const outputClaims = ctx.get(OutputClaimService);
    const utxoIndex = ctx.get(UtxoIndexService);

    const deferred: { service?: GenerationService } = {};
    const provider: GenerationProvider = {
      requestRestart: (prev, spec) => deferred.service!._onRestart(prev, spec),
    };

    super(provider);
    deferred.service = this;

    this._store = store;
    this._draftStore = draftStore;
    this._consensus = consensus;
    this._queue = queue;
    this._host = host;
    this._outputClaims = outputClaims;
    this._adapter = new GeneratingEnvAdapter(store, utxoIndex, outputClaims);

    consensus.onCanonicalityChange((hash, canonical) => {
      this.onCanonicalityChange(hash, canonical);
    });
  }

  /**
   * Install the hook used when a running generation rejects or errors and
   * needs to cancel the underlying draft (cleaning up consensus phantom
   * weight, output-claim entries, and the draft-store entry).
   *
   * Typically `setCancelHook(draftManager.cancelDraft.bind(draftManager))`.
   * We inject it rather than retrieve DraftManager from ProtocolContext
   * because DraftManager's constructor takes 3+ arguments and cannot be
   * DI-registered. NodeContext constructs both and wires them.
   */
  setCancelHook(cancel: (draftId: Hash) => void): void {
    this._cancelDraft = cancel;
  }

  // -- GeneratorProvider ---------------------------------------------

  /**
   * Called by `DraftManager` immediately after creating a draft. Extracts
   * the target verifier from the first resolved claim (the "trigger
   * output" that caused the draft to be created), registers the draft
   * with the tracking module, and enqueues the generation work on the
   * execution queue.
   *
   * A draft without any resolvedClaims does no generation -- we transition
   * it to 'ready' immediately with empty output. This preserves the old
   * `ContractGenerator` escape hatch.
   */
  generate(draft: BlockDraft): GeneratorHandle {
    const first = draft.resolvedClaims[0];
    if (!first) {
      this._draftStore.transition(draft.draftId, 'ready');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    const triggerBlock = this._store.get(first.block);
    if (!triggerBlock) {
      this._draftStore.transition(draft.draftId, 'cancelled');
      return { draftId: draft.draftId, cancel: () => {} };
    }
    const output = triggerBlock.outputs[first.outputIndex];
    if (!output) {
      this._draftStore.transition(draft.draftId, 'cancelled');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    const verifier = output.verifier;
    const spec: GenerationSpec = {
      targetKey: targetKeyFor(verifier),
      anchor: draft.anchor,
      verifier,
      declaredWeight: draft.declaredWeight,
    };

    this.register(draft.draftId, spec);

    const draftId = draft.draftId;

    // TODO: route through ExecutionQueueService so generation shares a
    // priority queue with verification and honors per-node cost budgets.
    // Doing that cleanly requires (a) the queue knowing how to run work
    // inline when possible to preserve the old sync-chain-of-puts
    // behavior some tests rely on, and (b) draft cancellation that
    // cooperates with queued task eviction -- both tracked in TODO.md
    // under "Execution Queue Preemption" and "GenerationModule Priority
    // Calibration". For now, run inline like the old ContractGenerator
    // did; priority()/register/forget are still live so the module-level
    // canonicality tracking works.
    const pending = this._runGeneration(draft, spec);
    if (pending instanceof Promise) pending.catch(() => {});

    return {
      draftId,
      cancel: () => {
        this._cancelled.add(draftId.toPrimitive());
        this._outputClaims.removeClaims(draftId);
        this._removeBlocked(draftId);
        this.forget(draftId);
      },
    };
  }

  // -- Restart handler -----------------------------------------------

  /**
   * Module asked us to restart. Allocate a fresh draft via DraftManager
   * with no resolvedClaims -- the contract's `collectInputs()` call (or
   * our default at end-of-run) will pick up fresh canonical UTXOs.
   *
   * We cannot call DraftManager.createDraft with an empty resolvedClaims
   * array today because the DraftManager pipeline assumes the trigger
   * output is already claimed. For now, we skip restart if the caller
   * hasn't wired a specialized restart path -- a real implementation
   * should pass the (targetKey, spec) up to the strategy that originally
   * triggered the draft so it can re-issue the createDraft action.
   *
   * TODO: surface a restart hook up to DraftStrategy so it can re-emit
   * a createDraft action with fresh inputs.
   */
  private _onRestart(_previousDraftId: Hash, _spec: GenerationSpec): void {
    // Intentional no-op: see docstring. Restart path is wired via the
    // reactive layer; the module's canonicality notification is still
    // useful because the old draft's priority decays immediately.
  }

  // -- Execution path -------------------------------------------------

  private _runGeneration(
    draft: BlockDraft,
    spec: GenerationSpec,
  ): Promise<void> | void {
    const draftId = draft.draftId;
    const waitForInput: WaitForInputFn = (verifier) =>
      new Promise<AvailableInput>((resolve) => {
        const vKey = utxoVerifierKey(verifier.contract, verifier.params);
        let queue = this._blocked.get(vKey);
        if (!queue) {
          queue = [];
          this._blocked.set(vKey, queue);
        }
        queue.push({ draftId, verifierKey: vKey, resolve });
      });

    let maybeResult;
    try {
      maybeResult = this._host.runGenerating({
        verifier: spec.verifier,
        provider: this._adapter,
        waitForInput,
      });
    } catch (_e) {
      if (!this._cancelled.has(draftId.toPrimitive())) {
        this._cancelDraft(draftId);
      }
      return;
    }

    const finish = (result: {
      outputs: Output[];
      resolvedClaims: { block: Hash; outputIndex: number; value: number }[];
      refs: Hash[];
      includeConstraints: Hash[];
    }) => {
      if (this._cancelled.has(draftId.toPrimitive())) return;
      this._applyResult(draft, result);
    };

    if (maybeResult instanceof Promise) {
      return maybeResult.then(
        (result) => finish(result),
        () => {
          if (!this._cancelled.has(draftId.toPrimitive())) {
            this._cancelDraft(draftId);
          }
        },
      );
    }
    finish(maybeResult);
  }

  private _applyResult(
    draft: BlockDraft,
    result: {
      outputs: Output[];
      resolvedClaims: { block: Hash; outputIndex: number; value: number }[];
      refs: Hash[];
      includeConstraints: Hash[];
    },
  ): void {
    const draftId = draft.draftId;

    // Register claims in OutputClaimService for conflict detection + UTXO pre-claim.
    for (const rc of result.resolvedClaims) {
      this._outputClaims.addClaim(draftId, rc.block, rc.outputIndex);
    }

    const existing = new Set(
      draft.resolvedClaims.map((rc: ClaimIntent) =>
        `${rc.block.toPrimitive()}:${rc.outputIndex}`
      ),
    );
    const newClaims = result.resolvedClaims.filter(
      (rc) => !existing.has(`${rc.block.toPrimitive()}:${rc.outputIndex}`),
    );
    const existingIncludes = new Set(
      draft.includeConstraints.map((h: Hash) => h.toPrimitive()),
    );
    const newIncludes = result.includeConstraints.filter(
      (h) => !existingIncludes.has(h.toPrimitive()),
    );

    const stored = this._draftStore.get(draftId);
    if (!stored) return; // explicitly cancelled during run

    this._draftStore.update(draftId, {
      outputs: [...stored.outputs, ...result.outputs],
      resolvedClaims: [...stored.resolvedClaims, ...newClaims],
      refs: [...stored.refs, ...result.refs],
      includeConstraints: [...stored.includeConstraints, ...newIncludes],
    });

    this._draftStore.transition(draftId, 'ready');
  }

  // -- Blocked-generator wakeup --------------------------------------

  /**
   * Notify that a new unclaimed output exists on a canonical block. Wakes
   * exactly one blocked generator waiting on the matching verifier, if any.
   * Returns true iff a generator was unblocked.
   *
   * Called from `DraftStrategy` on a canonicality event, same role that
   * `ContractGenerator.notifyNewOutput` used to play.
   */
  notifyNewOutput(blockHash: Hash, outputIndex: number, output: Output): boolean {
    const key = utxoVerifierKey(output.verifier.contract, output.verifier.params);
    const queue = this._blocked.get(key);
    if (!queue || queue.length === 0) return false;

    const entry = queue.shift()!;
    if (queue.length === 0) this._blocked.delete(key);

    this._outputClaims.addClaim(entry.draftId, blockHash, outputIndex);

    entry.resolve({
      verifier: output.verifier,
      value: output.value,
      data: output.data,
      isSelfClaim: false,
      block: blockHash,
      outputIndex,
    });
    return true;
  }

  /** Number of currently-blocked generators. For introspection/tests. */
  get blockedCount(): number {
    let n = 0;
    for (const q of this._blocked.values()) n += q.length;
    return n;
  }

  private _removeBlocked(draftId: Hash): void {
    for (const [key, queue] of this._blocked) {
      const filtered = queue.filter((e) => !Hash.equals(e.draftId, draftId));
      if (filtered.length === 0) this._blocked.delete(key);
      else this._blocked.set(key, filtered);
    }
  }
}

/** Stable target key derived from a verifier. */
function targetKeyFor(v: Verifier): string {
  return `${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
}
