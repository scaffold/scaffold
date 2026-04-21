// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import type { Verifier } from './BlockCreationModule.ts';
import type { ExecutionResult } from './ContractHost.ts';

// -- Types ----------------------------------------------------------

/**
 * Provider interface for ContractVerificationModule.
 *
 * The module is agnostic to:
 *   - how the contract is actually executed (runVerification)
 *   - how tasks are scheduled (enqueue)
 *   - where the budget and priority come from (budget, priority)
 *
 * All four callbacks are supplied per verify() call context via the provider.
 */
export interface ContractVerificationProvider {
  /**
   * Execute the verification for a single {block, verifier}.
   * Called by the module when it needs to resolve a cache miss.
   * The returned promise resolves with the ExecutionResult.
   */
  runVerification(blockHash: Hash, verifier: Verifier): Promise<ExecutionResult>;

  /**
   * Enqueue a task on the execution queue.
   *
   * Returns an opaque task id on acceptance, or undefined if the queue
   * rejected the task (typically because the budget exceeds the node's
   * max-acceptable cost). When undefined is returned, the module resolves
   * the verify() promise with `{ accepted: false, reason: 'declined' }`.
   *
   * `priority()` is called by the queue to sort, and may be re-evaluated.
   * `maxCostMs` is the per-verifier wall-clock budget.
   * `run()` is the queue's execution entry; it resolves when `runVerification`
   * resolves.
   */
  enqueue(task: {
    priority: () => number;
    maxCostMs: number;
    run: () => Promise<void>;
  }): string | undefined;

  /**
   * Per-verifier wall-clock budget in milliseconds, given the block under
   * verification. Callers typically derive this from `SamplingService`'s
   * `getTotalWeight(blockHash) * feeRate * msPerCostUnit`.
   *
   * Full per-verifier budget: no splitting across multiple verifiers on
   * the same block. See docs/protocol/computation.md#per-verifier-budget.
   */
  budgetMs(blockHash: Hash): number;

  /**
   * Scheduling priority for this {block, verifier}. Higher is more urgent.
   * Typically forwards to `SamplingService.getPriority(blockHash)`.
   */
  priority(blockHash: Hash, verifier: Verifier): number;
}

// -- Module ---------------------------------------------------------

/**
 * Deduplicating per-{block, verifier} contract verification cache.
 *
 * For a given {blockHash, verifier.contract, verifier.params} tuple:
 *   - If a result is cached, return it synchronously via a resolved promise.
 *   - If a run is in-flight, return the existing promise so all callers share one result.
 *   - Otherwise, enqueue a new task; resolve the promise on completion; cache forever.
 *
 * The result is valid forever: verification is pure over block content, and
 * block content is immutable once the block exists. We never evict.
 *
 * Queue rejection (task would exceed max acceptable cost) resolves with
 * `{ accepted: false, reason: 'declined' }` -- callers (sampling) treat this
 * as an incremented denominator with no verified count, per
 * docs/protocol/execution-queue.md#too-expensive-rejection.
 */
export class ContractVerificationModule {
  private readonly _provider: ContractVerificationProvider;

  /** Cache keyed by `${blockPrim}:${contractPrim}:${paramsBytes}`. */
  private readonly _results = new Map<string, ExecutionResult>();

  /** In-flight promises keyed by the same string. */
  private readonly _inflight = new Map<string, Promise<ExecutionResult>>();

  constructor(provider: ContractVerificationProvider) {
    this._provider = provider;
  }

  /**
   * Verify a single {block, verifier}. Returns cached/in-flight/new result.
   */
  verify(blockHash: Hash, verifier: Verifier): Promise<ExecutionResult> {
    const key = cacheKey(blockHash, verifier);

    const cached = this._results.get(key);
    if (cached) return Promise.resolve(cached);

    const inflight = this._inflight.get(key);
    if (inflight) return inflight;

    const budget = this._provider.budgetMs(blockHash);
    const priorityFn = () => this._provider.priority(blockHash, verifier);

    let resolveOuter!: (r: ExecutionResult) => void;
    const outer = new Promise<ExecutionResult>((res) => {
      resolveOuter = res;
    });
    this._inflight.set(key, outer);

    const finish = (r: ExecutionResult) => {
      this._inflight.delete(key);
      this._results.set(key, r);
      resolveOuter(r);
    };

    const taskId = this._provider.enqueue({
      priority: priorityFn,
      maxCostMs: budget,
      run: async () => {
        try {
          const result = await this._provider.runVerification(blockHash, verifier);
          finish(result);
        } catch (e) {
          finish({ accepted: false, reason: `run threw: ${e}` });
          // Re-throw so the queue classifies this as a failure as well.
          throw e;
        }
      },
    });

    if (taskId === undefined) {
      // Queue rejected: resolve with declined, cache it.
      finish({ accepted: false, reason: 'declined' });
    }

    return outer;
  }

  /**
   * Look up a cached result without enqueueing. Useful for introspection.
   */
  getCached(blockHash: Hash, verifier: Verifier): ExecutionResult | undefined {
    return this._results.get(cacheKey(blockHash, verifier));
  }

  /** Clear all caches. Primarily for test cleanup. */
  clear(): void {
    this._results.clear();
    this._inflight.clear();
  }
}

// -- Internals ------------------------------------------------------

function cacheKey(blockHash: Hash, verifier: Verifier): string {
  return `${blockHash.toPrimitive()}:${verifier.contract.toPrimitive()}:${
    paramsKey(verifier.params)
  }`;
}

function paramsKey(params: Uint8Array): string {
  let s = '';
  for (let i = 0; i < params.length; i++) {
    s += params[i].toString(16).padStart(2, '0');
  }
  return s;
}
