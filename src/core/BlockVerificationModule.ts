// Protocol spec: docs/protocol/computation.md

import { Hash, HashPrimitive } from '../util/Hash.ts';
import type { Verifier } from './BlockCreationModule.ts';

// -- Types ----------------------------------------------------------

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
  verifyContract(blockHash: Hash, verifier: Verifier): Promise<import('./ContractHost.ts').ExecutionResult>;
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
  private readonly _inflight = new Map<HashPrimitive, Promise<boolean>>();

  /** Resumption waiters: when a new resolution arrives, check if any deferred verify can proceed. */
  private readonly _waiters = new Map<HashPrimitive, (() => void)[]>();

  constructor(provider: BlockVerificationProvider) {
    this._provider = provider;
    provider.onResolution((claimant, target) => this._onResolution(claimant, target));
  }

  /**
   * Verify a block end-to-end. Returns a promise that resolves to `true`
   * iff every claim's contract accepts, `false` on first rejection.
   *
   * If any claim is still unresolved, the promise stays pending until the
   * output-claims module delivers the resolution.
   */
  verify(blockHash: Hash): Promise<boolean> {
    const key = blockHash.toPrimitive();
    const existing = this._inflight.get(key);
    if (existing) return existing;

    const promise = this._verifyOnce(blockHash);
    this._inflight.set(key, promise);
    // Clean up the in-flight entry once the promise settles.
    promise.finally(() => {
      if (this._inflight.get(key) === promise) this._inflight.delete(key);
    });
    return promise;
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
      !list.some((r) =>
        Hash.equals(r.block, target.block) && r.outputIndex === target.outputIndex
      )
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

  private async _verifyOnce(blockHash: Hash): Promise<boolean> {
    const key = blockHash.toPrimitive();

    // Loop: check resolutions, dispatch if complete, otherwise await next resolution.
    for (;;) {
      const claimCount = this._provider.getClaimCount(blockHash);
      if (claimCount === undefined) {
        // Block unknown locally. Wait for the coordinator to load it; it
        // will trigger the same path again. For now treat as "pending" --
        // defer and wait for any resolution to re-drive the check.
        await this._waitForResolution(key);
        continue;
      }

      // A block with zero claims trivially passes.
      if (claimCount === 0) return true;

      const targets = this._resolutions.get(key) ?? [];
      if (targets.length < claimCount) {
        await this._waitForResolution(key);
        continue;
      }

      // All claims resolved. Dispatch per-verifier verification in parallel.
      const promises: Promise<import('./ContractHost.ts').ExecutionResult>[] = [];
      for (const target of targets.slice(0, claimCount)) {
        const verifier = this._provider.getVerifier(target.block, target.outputIndex);
        if (!verifier) {
          // Claim points at an output we don't know. Treat as reject --
          // a malformed or orphan claim.
          return false;
        }
        promises.push(this._provider.verifyContract(blockHash, verifier));
      }

      // Fail-fast on first reject.
      for (const p of promises) {
        const result = await p;
        if (!result.accepted) return false;
      }
      return true;
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
