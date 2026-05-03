// Protocol spec: docs/protocol/draft-blocks.md

import { Hash, HashPrimitive, ZERO_HASH } from '../util/Hash.ts';
import type { Output, Verifier } from '../core/BlockCreationModule.ts';
import {
  Block,
  BlockStore,
  makeBlockStoreOutputSpace,
  resolveClaimToOutput,
} from '../core/Block.ts';
import { OutputSpaceModule } from '../core/OutputSpace.ts';
import { Draft, ClaimIntent, DraftStore } from '../core/Draft.ts';
import type { ClaimRef } from '../core/Node.ts';
import { type AvailableInput, type GeneratingEnvProvider } from '../core/ContractEnv.ts';
import type { OutputSlot } from '../core/GeneratingEnv.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { ExecutionQueueService } from '../core/ExecutionQueueService.ts';
import { OutputClaimService } from '../core/OutputClaimService.ts';
import { OutputHandlerRegistry } from '../core/OutputHandlerRegistry.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';
import { verifierKey as utxoVerifierKey } from './UtxoIndex.ts';
import { UtxoIndexService } from './UtxoIndexService.ts';
import { type WaitForGetOutputFn, type WaitForInputFn } from '../core/GeneratingEnv.ts';
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
  private readonly outputSpace: OutputSpaceModule;

  constructor(
    private readonly store: BlockStore,
    private readonly utxoIndex: UtxoIndexService,
    private readonly outputHandlers: OutputHandlerRegistry,
  ) {
    this.outputSpace = makeBlockStoreOutputSpace(store);
  }

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getOutputs(block: Block): Output[] {
    return block.outputs;
  }

  getClaims(block: Block): number[] {
    return block.claimIndices;
  }

  getRefs(block: Block): Hash[] {
    return block.refs;
  }

  resolveClaim(block: Block, claimIndex: number): Output | undefined {
    return resolveClaimToOutput(block, claimIndex, this.store, this.outputSpace)?.output;
  }

  findInputs(verifier: Verifier): AvailableInput[] {
    // UtxoIndex now filters canonicality + claim status at read time, so
    // no additional filtering is needed here. Null-data outputs are
    // pure-incentive and invisible to contracts, so drop them here.
    const entries = this.utxoIndex.getByVerifier(verifier.contract, verifier.params);
    const result: AvailableInput[] = [];
    for (const entry of entries) {
      const block = this.store.get(entry.blockHash);
      if (!block || entry.outputIndex >= block.outputs.length) continue;
      const output = block.outputs[entry.outputIndex];
      if (output.data === null) continue;
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
      const ownOutputCount = block.outputs.length;
      for (const claimIdx of block.claimIndices) {
        if (claimIdx < ownOutputCount) continue; // self-claim -- doesn't count
        const resolved = resolveClaimToOutput(block, claimIdx, this.store, this.outputSpace);
        if (!resolved) continue;
        if (
          Hash.equals(resolved.output.verifier.contract, verifier.contract) &&
          bytesEqual(resolved.output.verifier.params, verifier.params)
        ) {
          return block.hash;
        }
      }
    }
    return undefined;
  }

  resolveGetOutput(
    runningContract: Hash,
    runningParams: Uint8Array,
    outputVerifier: Verifier,
  ): Promise<{ value: number; data: Uint8Array } | null> {
    return this.outputHandlers.resolve(
      runningContract,
      runningParams,
      outputVerifier,
    );
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

/** A generator parked in `getOutput` waiting for a user handler to match. */
interface ParkedGetOutput {
  draftId: Hash;
  runningContract: Hash;
  runningParams: Uint8Array;
  outputVerifier: Verifier;
  resolve: (result: { value: number; data: Uint8Array }) => void;
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
  private readonly _utxoIndex: UtxoIndexService;
  private readonly _adapter: GeneratingEnvAdapter;
  /** Hook for draft cancellation. Set by NodeContext after construction. */
  private _cancelDraft: (draftId: Hash) => void = () => {};

  /**
   * Hook notified when an output is released back to the system -- either
   * because a draft completed without consuming its pre-queue or because
   * the draft was cancelled. DraftStrategy uses this to clear its
   * per-output in-flight tracking so subsequent drafts can claim the
   * output. Set by NodeContext after construction.
   */
  private _onOutputReleased: (block: Hash, outputIndex: number) => void = () => {};

  /** Blocked generators waiting for inputs, keyed by verifier. */
  private readonly _blocked = new Map<string, BlockedEntry[]>();

  /**
   * Generators parked in `getOutput` waiting for a user handler to match.
   * Keyed by the running contract hash (OutputHandlerRegistry dispatches by
   * running contract). When a user handler registers for that contract, we
   * re-run the resolver for each parked entry; entries whose handler now
   * returns non-null resolve.
   */
  private readonly _parkedGetOutput = new Map<HashPrimitive, ParkedGetOutput[]>();

  /**
   * Outputs adopted into an active draft before its contract blocked --
   * keyed by draftId. When the contract calls `waitForInput`, these are
   * consumed first; if empty, the waiter parks in `_blocked`.
   */
  private readonly _preQueue = new Map<HashPrimitive, AvailableInput[]>();

  /** Draft-level cancellation flags. Checked by the run loop. */
  private readonly _cancelled = new Set<HashPrimitive>();

  /** The node's public key, used for requireSignature in generation. */
  private _signerPubkey: Uint8Array | undefined;

  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const draftStore = ctx.get(DraftStore);
    const consensus = ctx.get(ConsensusService);
    const queue = ctx.get(ExecutionQueueService);
    const host = ctx.get(ContractHostService);
    const outputClaims = ctx.get(OutputClaimService);
    const utxoIndex = ctx.get(UtxoIndexService);
    const outputHandlers = ctx.get(OutputHandlerRegistry);

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
    this._utxoIndex = utxoIndex;
    this._adapter = new GeneratingEnvAdapter(store, utxoIndex, outputHandlers);

    consensus.onCanonicalityChange((hash, canonical) => {
      this.onCanonicalityChange(hash, canonical);
    });

    // Wake generators parked in `getOutput` when a new user handler lands
    // for the running contract. The handler may or may not actually resolve
    // the parked request -- we re-run the resolver chain and keep the entry
    // parked if everything still returns null.
    outputHandlers.onUserHandlerRegistered((runningContract) => {
      this._retryParkedGetOutput(runningContract);
    });

    // Wake blocked contracts when a reorg frees up an output. Without
    // this hook, a contract that called `requireInput()` before the
    // matching UTXO existed would stay parked forever if the only way
    // the UTXO appears is via an existing claimant becoming non-canonical
    // (DraftStrategy only reacts to newly-canonical events).
    utxoIndex.onOutputReAdded((blockHash, outputIndex) => {
      const block = store.get(blockHash);
      if (!block) return;
      if (outputIndex >= block.outputs.length) return;
      this.notifyNewOutput(blockHash, outputIndex, block.outputs[outputIndex]);
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

  /** Hook so DraftStrategy can clear its per-output inFlight tracking. */
  setOutputReleasedHook(cb: (block: Hash, outputIndex: number) => void): void {
    this._onOutputReleased = cb;
  }

  /**
   * Install the node's own public key. `requireSignature` in generation
   * mode uses this to decide whether the draft can be signed by the
   * required pubkey at solidification. Set by NodeContext after
   * construction (since the key isn't part of ProtocolContext DI).
   */
  setSignerPubkey(pubkey: Uint8Array): void {
    this._signerPubkey = pubkey;
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
  generate(draft: Draft): GeneratorHandle {
    const first = draft.claims[0];
    if (!first) {
      this._draftStore.transition(draft.draftId, 'ready');
      return { draftId: draft.draftId, cancel: () => {} };
    }

    const triggerBlock = this._store.get(first.producer);
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
      verifier,
      declaredWeight: draft.declaredWeight,
    };

    this.register(draft.draftId, spec);

    const draftId = draft.draftId;
    // Budget: declaredWeight * msPerCostUnit, but floor at 30s until
    // we have real contract-cost data. declaredWeight today is a nominal
    // 1-or-small-integer and `msPerCostUnit` defaults to 1, which would
    // yield a 1ms budget -- enough to time out every real contract run.
    // See TODO.md "GenerationModule Priority Calibration".
    const budget = Math.max(
      spec.declaredWeight * this._queue.msPerCostUnit,
      30_000,
    );
    const executable = {
      priority: () => this.priority(draftId),
      maxCostMs: budget,
      run: async () => {
        const pending = this._runGeneration(draft, spec);
        if (pending instanceof Promise) await pending;
      },
    };
    this._queue.enqueue(executable);

    return {
      draftId,
      cancel: () => {
        this._cancelled.add(draftId.toPrimitive());
        // Release the draft's claim entries first so subsequent
        // notifyNewOutput calls don't see a self-conflict.
        this._outputClaims.removeClaims(draftId);

        // Re-route any pre-queued inputs the contract didn't consume
        // through `notifyNewOutput`: wake a blocked generator, adopt
        // into another active draft, or fall back to `reAddUnspentOutput`
        // so DraftStrategy sees the UTXO on the next canonicality event.
        // In every case, tell DraftStrategy the output is no longer
        // tracked by *this* draft so its inFlight counter stays accurate.
        const pre = this._preQueue.get(draftId.toPrimitive());
        if (pre) {
          for (const ai of pre) {
            this._onOutputReleased(ai.block, ai.outputIndex);
            const absorbed = this.notifyNewOutput(ai.block, ai.outputIndex, {
              verifier: ai.verifier,
              value: ai.value,
              data: ai.data,
            });
            if (!absorbed) {
              this._utxoIndex.reAddUnspentOutput(ai.block, ai.outputIndex);
            }
          }
          this._preQueue.delete(draftId.toPrimitive());
        }
        this._removeBlocked(draftId);
        this._removeParkedGetOutput(draftId);
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
    draft: Draft,
    spec: GenerationSpec,
  ): Promise<void> | void {
    const draftId = draft.draftId;
    const waitForInput: WaitForInputFn = (verifier) => {
      // Drain the pre-queue first: outputs adopted by `notifyNewOutput`
      // before this contract reached `waitForInput`.
      const pre = this._preQueue.get(draftId.toPrimitive());
      if (pre && pre.length > 0) {
        const ai = pre.shift()!;
        if (pre.length === 0) this._preQueue.delete(draftId.toPrimitive());
        return Promise.resolve(ai);
      }
      return new Promise<AvailableInput>((resolve) => {
        const vKey = utxoVerifierKey(verifier.contract, verifier.params);
        let queue = this._blocked.get(vKey);
        if (!queue) {
          queue = [];
          this._blocked.set(vKey, queue);
        }
        queue.push({ draftId, verifierKey: vKey, resolve });
      });
    };

    const waitForGetOutput: WaitForGetOutputFn = (outputVerifier) => {
      return new Promise((resolve) => {
        const runningKey = spec.verifier.contract.toPrimitive();
        let queue = this._parkedGetOutput.get(runningKey);
        if (!queue) {
          queue = [];
          this._parkedGetOutput.set(runningKey, queue);
        }
        queue.push({
          draftId,
          runningContract: spec.verifier.contract,
          runningParams: spec.verifier.params,
          outputVerifier,
          resolve,
        });
      });
    };

    let maybeResult;
    try {
      maybeResult = this._host.runGenerating({
        verifier: spec.verifier,
        provider: this._adapter,
        waitForInput,
        waitForGetOutput,
        signerPubkey: this._signerPubkey,
      });
    } catch (_e) {
      if (!this._cancelled.has(draftId.toPrimitive())) {
        this._cancelDraft(draftId);
      }
      return;
    }

    const finish = (result: {
      outputs: Output[];
      outputSlots: OutputSlot[];
      claims: ClaimRef[];
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
    draft: Draft,
    result: {
      outputs: Output[];
      outputSlots: OutputSlot[];
      claims: ClaimRef[];
      refs: Hash[];
      includeConstraints: Hash[];
    },
  ): void {
    const draftId = draft.draftId;

    // Register claims in OutputClaimService for conflict detection + UTXO pre-claim.
    for (const c of result.claims) {
      this._outputClaims.addClaim(draftId, c.producer, c.outputIndex);
    }

    const existing = new Set(
      draft.claims.map((c) => `${c.producer.toPrimitive()}:${c.outputIndex}`),
    );
    const newClaims: ClaimRef[] = result.claims
      .filter((c) => !existing.has(`${c.producer.toPrimitive()}:${c.outputIndex}`));

    const stored = this._draftStore.get(draftId);
    if (!stored) return; // explicitly cancelled during run

    const updated = this._draftStore.update(draftId, {
      outputs: [...stored.outputs, ...result.outputs],
      outputSlots: [...stored.outputSlots, ...result.outputSlots],
      claims: [...stored.claims, ...newClaims],
      refs: [...stored.refs, ...result.refs],
    });

    // Reconcile UtxoIndex with the draft's new claims. Consensus
    // doesn't fire a canonicality-change event for an already-canonical
    // draft whose internal state changed, so we trigger the reconciliation
    // directly. Both methods are idempotent (Map.delete / Map.set).
    if (this._consensus.isCanonical(draftId)) {
      this._utxoIndex.draftBecameCanonical(updated);
    } else {
      this._utxoIndex.draftBecameNonCanonical(updated);
    }

    // Forget the draft from module tracking before transitioning to
    // 'ready': solidification runs synchronously in the ready-transition
    // listener and produces a real block whose outputs may trigger new
    // drafts for the same target. Keeping the old draft in the active
    // set would (incorrectly) suppress those via `hasActiveTarget`.
    this.forget(draftId);

    this._draftStore.transition(draftId, 'ready');
  }

  // -- Blocked-generator wakeup --------------------------------------

  /**
   * Notify that a new unclaimed output exists on a canonical block.
   * Returns `true` iff the output was absorbed into an existing generation
   * (either by waking a blocked generator or by being adopted by an
   * actively-running draft for the same target).
   *
   * Resolution order:
   *   1. If any generator is blocked on this verifier, wake it and return.
   *   2. Else if any active draft has a matching targetKey, claim the
   *      output on its behalf so `UtxoIndex` reflects the reservation.
   *      The running contract will pick it up on its next `findInputs`
   *      call (or via `_blocked` if it has blocked in the meantime).
   *   3. Else return `false`, signalling the caller (`DraftStrategy`)
   *      that this output isn't claimed yet and may warrant a new draft.
   */
  notifyNewOutput(blockHash: Hash, outputIndex: number, output: Output): boolean {
    // Null-data outputs are pure-incentive and invisible to contracts --
    // they cannot be waked into or adopted by a running generator.
    if (output.data === null) return false;
    const vKey = utxoVerifierKey(output.verifier.contract, output.verifier.params);

    // 1. Wake blocked generator.
    const queue = this._blocked.get(vKey);
    if (queue && queue.length > 0) {
      const entry = queue.shift()!;
      if (queue.length === 0) this._blocked.delete(vKey);
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

    // 2. Adopt into an active draft with matching target.
    const targetKey = targetKeyForBytes(output.verifier);
    const draftsForTarget = this.draftsForTarget(targetKey);
    if (draftsForTarget.length > 0) {
      const claimant = draftsForTarget[0];
      this._outputClaims.addClaim(claimant, blockHash, outputIndex);
      // Reflect in the UTXO view so parallel `findInputs` calls don't
      // re-pick this output, and `autoBalance` doesn't double-spend.
      this._utxoIndex.removeSpentOutput(blockHash, outputIndex);
      // Park the AvailableInput for the draft's next waitForInput call.
      const ai: AvailableInput = {
        verifier: output.verifier,
        value: output.value,
        data: output.data,
        isSelfClaim: false,
        block: blockHash,
        outputIndex,
      };
      const claimantKey = claimant.toPrimitive();
      let pre = this._preQueue.get(claimantKey);
      if (!pre) {
        pre = [];
        this._preQueue.set(claimantKey, pre);
      }
      pre.push(ai);
      return true;
    }

    return false;
  }

  /** True iff an active generation exists for the given verifier. */
  hasActiveGenerationFor(verifier: Verifier): boolean {
    return this.hasActiveTarget(targetKeyForBytes(verifier));
  }

  /** Number of currently-blocked generators. For introspection/tests. */
  get blockedCount(): number {
    let n = 0;
    for (const q of this._blocked.values()) n += q.length;
    return n;
  }

  /** Number of generators parked in `getOutput`. For introspection/tests. */
  get parkedGetOutputCount(): number {
    let n = 0;
    for (const q of this._parkedGetOutput.values()) n += q.length;
    return n;
  }

  /** Debug: list parked getOutput entries. */
  debugParkedGetOutput(): {
    runningContract: string;
    runningParamsHex: string;
    outputContract: string;
    outputParamsHex: string;
  }[] {
    const out: ReturnType<GenerationService['debugParkedGetOutput']> = [];
    for (const queue of this._parkedGetOutput.values()) {
      for (const e of queue) {
        out.push({
          runningContract: e.runningContract.toHex().slice(0, 8),
          runningParamsHex: Array.from(e.runningParams)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
          outputContract: e.outputVerifier.contract.toHex().slice(0, 8),
          outputParamsHex: Array.from(e.outputVerifier.params)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        });
      }
    }
    return out;
  }

  private _removeBlocked(draftId: Hash): void {
    for (const [key, queue] of this._blocked) {
      const filtered = queue.filter((e) => !Hash.equals(e.draftId, draftId));
      if (filtered.length === 0) this._blocked.delete(key);
      else this._blocked.set(key, filtered);
    }
  }

  private _removeParkedGetOutput(draftId: Hash): void {
    for (const [key, queue] of this._parkedGetOutput) {
      const filtered = queue.filter((e) => !Hash.equals(e.draftId, draftId));
      if (filtered.length === 0) this._parkedGetOutput.delete(key);
      else this._parkedGetOutput.set(key, filtered);
    }
  }

  /**
   * Called when a new user handler registers for `runningContract`. Re-run
   * the resolver chain for every parked getOutput on that contract hash and
   * resolve any whose handler chain now returns non-null. Entries that still
   * resolve to null stay parked.
   *
   * The registry resolves asynchronously; we iterate serially per-entry so
   * that a handler that itself blocks (e.g., awaits user input) doesn't
   * prevent other entries from being considered.
   */
  private _retryParkedGetOutput(runningContract: Hash): void {
    const key = runningContract.toPrimitive();
    const queue = this._parkedGetOutput.get(key);
    if (!queue || queue.length === 0) return;
    // Snapshot and clear; survivors get re-parked.
    const snapshot = queue.splice(0);
    this._parkedGetOutput.delete(key);

    for (const entry of snapshot) {
      if (this._cancelled.has(entry.draftId.toPrimitive())) continue;
      // Re-run the resolver. If it returns non-null, resolve the parked
      // promise. Otherwise re-park.
      this._adapter.resolveGetOutput(
        entry.runningContract,
        entry.runningParams,
        entry.outputVerifier,
      ).then((resolved) => {
        if (this._cancelled.has(entry.draftId.toPrimitive())) return;
        if (resolved !== null) {
          entry.resolve(resolved);
          return;
        }
        let q = this._parkedGetOutput.get(key);
        if (!q) {
          q = [];
          this._parkedGetOutput.set(key, q);
        }
        q.push(entry);
      });
    }
  }
}

/** Stable target key derived from a verifier. */
function targetKeyFor(v: Verifier): string {
  return `${v.contract.toPrimitive()}:${Array.from(v.params).join(',')}`;
}

/** Same key, re-exported for call sites with a `Verifier` literal. */
function targetKeyForBytes(v: Verifier): string {
  return targetKeyFor(v);
}
