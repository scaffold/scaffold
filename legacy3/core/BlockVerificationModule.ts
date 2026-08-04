// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import { NamespacePartitionModule, type OwnerContribution } from './NamespacePartitionModule.ts';

// -- Types ----------------------------------------------------------

/** Block-level verification status, as reported by `getStatus`. */
export type VerificationStatus = 'unknown' | 'verifying' | 'passed' | 'failed';

/**
 * Provider interface for BlockVerificationModule.
 *
 * Keeps the module agnostic to the concrete block type, the output-claims
 * module, and the contract verification layer. Tests wire in mocks; the
 * service wires in the real BlockStore / OutputClaimService /
 * ContractVerificationService.
 */
export interface BlockVerificationProvider {
  /**
   * Number of claims on a block. Used to know when all resolutions have arrived.
   * Returns undefined if the block is unknown locally.
   */
  getClaimCount(blockHash: Hash): number | undefined;

  /**
   * Look up the verifier for a resolved claim target (block + outputIndex).
   * Returns undefined if the target block is unknown or the index is out of range.
   */
  getVerifier(targetBlock: Hash, outputIndex: number): Verifier | undefined;

  /**
   * Register a listener for claim-resolution events produced by the output-claims
   * module. `cb` receives `(claimant, target)`. The module accumulates these
   * per claimant.
   */
  onResolution(cb: (claimant: Hash, target: { block: Hash; outputIndex: number }) => void): void;

  /**
   * Dispatch contract verification for a single {block, verifier}.
   * Typically forwards to `ContractVerificationModule.verify`.
   */
  verifyContract(
    blockHash: Hash,
    verifier: Verifier,
  ): Promise<import('./ContractHost.ts').ExecutionResult>;

  /**
   * Look up a block's outputs for the namespace-partition check.
   * Returns undefined if the block is unknown locally.
   */
  getOutputs(blockHash: Hash): Output[] | undefined;

  /**
   * Look up a contract's declared output namespaces. Returns [] if the
   * contract declares nothing or is unregistered. See
   * docs/protocol/computation.md#output-namespaces.
   */
  getOutputNamespaces(contractHash: Hash): Hash[];
}

// -- Module ---------------------------------------------------------

/**
 * Per-block verification orchestrator.
 *
 * `verify(hash)` enumerates a block's resolved claims, dispatches per-
 * `{block, verifier}` verification, and resolves with `true` iff every
 * contract accepts. On the first rejection, the aggregate resolves
 * `false` (fail-fast); in-flight per-verifier runs are not cancelled
 * today (see TODO: cumulative budget cap in `docs/protocol/computation.md`).
 *
 * Block-level dedupe: multiple concurrent `verify(hash)` calls share one
 * in-flight promise.
 *
 * Deferred verification: if not all claims are resolved yet (anchor missing),
 * the module registers a one-shot internal resumption that re-drives when
 * the final resolution arrives via `OutputClaimService.onResolution`. The
 * caller's promise stays pending -- verification is never failed for
 * unresolved claims.
 */
export class BlockVerificationModule {
  private readonly _provider: BlockVerificationProvider;
  private readonly _partition = new NamespacePartitionModule();

  /**
   * Per-claimant accumulated resolutions. Populated by onResolution events
   * forwarded from the provider. Blocks can arrive before their claims do,
   * so this map is a best-effort cache.
   */
  private readonly _resolutions = new Map<
    HashPrimitive,
    { block: Hash; outputIndex: number }[]
  >();

  /** In-flight block-level verify() promises. */
  private readonly _inflight = new Map<
    HashPrimitive,
    Promise<import('./ContractHost.ts').ExecutionResult>
  >();

  /**
   * Final results per block, populated once the corresponding verify()
   * promise settles. Block content is immutable, so a result is valid
   * forever -- we never evict, and `getStatus` reports `passed`/`failed`
   * from this map once set.
   */
  private readonly _results = new Map<
    HashPrimitive,
    import('./ContractHost.ts').ExecutionResult
  >();

  /** Listeners notified on each status transition. */
  private readonly _statusListeners: (
    (hash: Hash, status: VerificationStatus) => void
  )[] = [];

  /** Resumption waiters: when a new resolution arrives, check if any deferred verify can proceed. */
  private readonly _waiters = new Map<HashPrimitive, (() => void)[]>();

  constructor(provider: BlockVerificationProvider) {
    this._provider = provider;
    provider.onResolution((claimant, target) => this._onResolution(claimant, target));
  }

  /**
   * Verify a block end-to-end. Returns a promise that resolves to
   * `{accepted: true}` iff every claim's contract accepts. On the first
   * rejection resolves `{accepted: false, reason}` with the contract-
   * level reason from the rejecting verifier.
   *
   * If any claim is still unresolved, the promise stays pending until the
   * output-claims module delivers the resolution.
   */
  verify(blockHash: Hash): Promise<import('./ContractHost.ts').ExecutionResult> {
    const key = blockHash.toPrimitive();

    // Cache hit: block content is immutable, so past results are final.
    const cached = this._results.get(key);
    if (cached) return Promise.resolve(cached);

    const existing = this._inflight.get(key);
    if (existing) return existing;

    const promise = this._verifyOnce(blockHash).then((result) => {
      this._results.set(key, result);
      this._fireStatus(blockHash, result.accepted ? 'passed' : 'failed');
      return result;
    });
    this._inflight.set(key, promise);
    this._fireStatus(blockHash, 'verifying');
    promise.finally(() => {
      if (this._inflight.get(key) === promise) this._inflight.delete(key);
    });
    return promise;
  }

  /**
   * Synchronous status query. Returns `'unknown'` before verification
   * has ever been requested, `'verifying'` while a verify() promise is
   * in flight, and `'passed'`/`'failed'` once it has settled. The latter
   * two are final -- block content is immutable.
   */
  getStatus(blockHash: Hash): VerificationStatus {
    const key = blockHash.toPrimitive();
    const cached = this._results.get(key);
    if (cached) return cached.accepted ? 'passed' : 'failed';
    if (this._inflight.has(key)) return 'verifying';
    return 'unknown';
  }

  /**
   * Register a listener for status transitions. Fires on each change:
   * `unknown -> verifying` when a fresh `verify()` call begins, and
   * `verifying -> passed|failed` when it settles. Returns an unsubscribe
   * function.
   *
   * Does not fire for cached-hit `verify()` calls (status was already
   * terminal).
   */
  onStatusChanged(
    cb: (hash: Hash, status: VerificationStatus) => void,
  ): () => void {
    this._statusListeners.push(cb);
    return () => {
      const i = this._statusListeners.indexOf(cb);
      if (i >= 0) this._statusListeners.splice(i, 1);
    };
  }

  private _fireStatus(hash: Hash, status: VerificationStatus): void {
    for (const cb of this._statusListeners) cb(hash, status);
  }

  // -- Internals --------------------------------------------------

  private _onResolution(
    claimant: Hash,
    target: { block: Hash; outputIndex: number },
  ): void {
    const key = claimant.toPrimitive();
    let list = this._resolutions.get(key);
    if (!list) {
      list = [];
      this._resolutions.set(key, list);
    }
    // Dedupe by (block, outputIndex). Multiple migrations can in theory
    // re-fire the same resolution; keep only the first.
    if (
      !list.some((r) => Hash.equals(r.block, target.block) && r.outputIndex === target.outputIndex)
    ) {
      list.push(target);
    }

    // Wake all waiters for this claimant.
    const waiters = this._waiters.get(key);
    if (waiters) {
      this._waiters.delete(key);
      for (const w of waiters) w();
    }
  }

  private async _verifyOnce(
    blockHash: Hash,
  ): Promise<import('./ContractHost.ts').ExecutionResult> {
    const key = blockHash.toPrimitive();

    for (;;) {
      const claimCount = this._provider.getClaimCount(blockHash);
      if (claimCount === undefined) {
        await this._waitForResolution(key);
        continue;
      }

      if (claimCount === 0) return { accepted: true as const };

      const targets = this._resolutions.get(key) ?? [];
      if (targets.length < claimCount) {
        await this._waitForResolution(key);
        continue;
      }

      const dispatch: {
        verifier: Verifier;
        promise: Promise<import('./ContractHost.ts').ExecutionResult>;
      }[] = [];
      for (const target of targets.slice(0, claimCount)) {
        const verifier = this._provider.getVerifier(target.block, target.outputIndex);
        if (!verifier) {
          return { accepted: false, reason: 'claimed output not found' };
        }
        dispatch.push({ verifier, promise: this._provider.verifyContract(blockHash, verifier) });
      }

      // Fail-fast on first reject, but all dispatches are already in flight
      // (no cancellation today -- see TODO on cumulative budget cap).
      const resultsByVerifier: {
        verifier: Verifier;
        result: import('./ContractHost.ts').ExecutionResult;
      }[] = [];
      for (const { verifier, promise } of dispatch) {
        const result = await promise;
        if (!result.accepted) return result;
        resultsByVerifier.push({ verifier, result });
      }

      // Block-level namespace partition check. Runs after every claim's
      // contract has accepted; confirms the block's outputs layout matches
      // the owning contracts' emitted sequences. See
      // docs/protocol/computation.md#output-namespaces.
      const blockOutputs = this._provider.getOutputs(blockHash);
      if (!blockOutputs) {
        // Block vanished between claim check and output lookup -- benign.
        return { accepted: true as const };
      }
      const contributions: OwnerContribution[] = resultsByVerifier.map(
        ({ verifier, result }) => ({
          runningVerifier: verifier,
          declaredNamespaces: this._provider.getOutputNamespaces(verifier.contract),
          emittedSlots:
            (result as { accepted: true; emittedSlots?: import('./GeneratingEnv.ts').OutputSlot[] })
              .emittedSlots ?? [],
        }),
      );
      const partition = this._partition.check(blockOutputs, contributions);
      if (!partition.ok) {
        return { accepted: false, reason: `namespace partition: ${partition.reason}` };
      }
      return { accepted: true as const };
    }
  }

  private _waitForResolution(key: HashPrimitive): Promise<void> {
    return new Promise<void>((resolve) => {
      let list = this._waiters.get(key);
      if (!list) {
        list = [];
        this._waiters.set(key, list);
      }
      list.push(resolve);
    });
  }
}
