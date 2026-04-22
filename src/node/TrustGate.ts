// Design spec: docs/design/trust-gate.md
//
// TrustGate -- node-wide trust policy. A block is trusted iff:
//   1. local verification accepted it (`trusted(verified)`, final), OR
//   2. a canonical, verified/ready resolution source emitted a 'valid'
//      verdict output for it (`trusted(collateralized)`; revocable on
//      canonicality flips or newly-arriving 'invalid' verdicts).
//
// Rejection sources:
//   - local verification `failed` -> permanent rejection.
//   - 'invalid' resolution verdict from a canonical source -> revocable.
//
// Local verification always wins over resolution verdicts. See
// docs/design/trust-gate.md for the precedence rules and rationale.

import type { Hash } from '../util/Hash.ts';
import type { ExecutionResult } from '../core/ContractHost.ts';
import {
  CollateralRejectedError,
  TrustTimeoutError,
  VerificationRejectedError,
} from './TrustErrors.ts';

// -- Types ------------------------------------------------------------

export type VerificationStatus = 'unknown' | 'verifying' | 'passed' | 'failed';
export type VerdictQuery = 'valid' | 'invalid' | 'none';

export type TrustStatus =
  | { kind: 'untrusted' }
  | { kind: 'trusted'; basis: 'verified' | 'collateralized' }
  | { kind: 'rejected'; reason: 'local verification' | 'collateral resolution' };

export interface TrustGateProvider {
  getVerificationStatus(h: Hash): VerificationStatus;
  onVerificationStatusChanged(
    cb: (h: Hash, s: VerificationStatus) => void,
  ): () => void;
  requestVerification(h: Hash): Promise<ExecutionResult>;

  getVerdict(h: Hash): VerdictQuery;
  onVerdictChanged(cb: (h: Hash, v: VerdictQuery) => void): () => void;
}

// -- TrustGate --------------------------------------------------------

export class TrustGate {
  private readonly _listeners: ((h: Hash, s: TrustStatus) => void)[] = [];
  /** Last-fired status per hash, so we only fire on real transitions. */
  private readonly _last = new Map<string, TrustStatus>();

  constructor(private readonly provider: TrustGateProvider) {
    provider.onVerificationStatusChanged((h) => this._fireIfChanged(h));
    provider.onVerdictChanged((h) => this._fireIfChanged(h));
  }

  /**
   * Pure read. Never triggers verification.
   */
  status(hash: Hash): TrustStatus {
    const vs = this.provider.getVerificationStatus(hash);
    if (vs === 'passed') return { kind: 'trusted', basis: 'verified' };
    if (vs === 'failed') {
      return { kind: 'rejected', reason: 'local verification' };
    }
    const v = this.provider.getVerdict(hash);
    if (v === 'invalid') {
      return { kind: 'rejected', reason: 'collateral resolution' };
    }
    if (v === 'valid') return { kind: 'trusted', basis: 'collateralized' };
    return { kind: 'untrusted' };
  }

  /**
   * Wait until the block's trust status is trusted or rejected.
   *
   * If currently untrusted, kicks off `requestVerification(hash)`
   * (dedup-aware via the underlying service). Resolves on the first
   * trust-positive transition with the trusted `TrustStatus`; rejects
   * on first rejection or timeout.
   */
  awaitTrusted(
    hash: Hash,
    opts: { timeoutMs?: number } = {},
  ): Promise<TrustStatus & { kind: 'trusted' }> {
    const current = this.status(hash);
    if (current.kind === 'trusted') return Promise.resolve(current);
    if (current.kind === 'rejected') {
      return Promise.reject(rejectionError(current));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const unsubscribe = this.onTrustChanged((h, s) => {
        if (settled) return;
        if (h.toHex() !== hash.toHex()) return;
        if (s.kind === 'trusted') {
          settled = true;
          cleanup();
          resolve(s);
        } else if (s.kind === 'rejected') {
          settled = true;
          cleanup();
          reject(rejectionError(s));
        }
      });

      const cleanup = () => {
        unsubscribe();
        if (timer !== undefined) clearTimeout(timer);
      };

      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new TrustTimeoutError(opts.timeoutMs!));
        }, opts.timeoutMs);
      }

      // Kick off verification. We intentionally ignore the returned
      // promise -- transitions flow through onVerificationStatusChanged.
      // Errors from requestVerification are swallowed; if verification
      // actually fails, we'll see a 'failed' status transition.
      this.provider.requestVerification(hash).catch(() => {});
    });
  }

  /**
   * Fires once per real `TrustStatus` transition for a given hash.
   * Cached reads (identical status) don't trigger events.
   */
  onTrustChanged(cb: (hash: Hash, status: TrustStatus) => void): () => void {
    this._listeners.push(cb);
    return () => {
      const i = this._listeners.indexOf(cb);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  // -- internal --

  private _fireIfChanged(hash: Hash): void {
    const key = hash.toHex();
    const next = this.status(hash);
    const prev = this._last.get(key);
    if (prev && trustEqual(prev, next)) return;
    this._last.set(key, next);
    for (const cb of this._listeners) cb(hash, next);
  }
}

// -- helpers ----------------------------------------------------------

function trustEqual(a: TrustStatus, b: TrustStatus): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'trusted' && b.kind === 'trusted') {
    return a.basis === b.basis;
  }
  if (a.kind === 'rejected' && b.kind === 'rejected') {
    return a.reason === b.reason;
  }
  return true;
}

function rejectionError(s: TrustStatus & { kind: 'rejected' }): Error {
  if (s.reason === 'local verification') {
    return new VerificationRejectedError(s.reason);
  }
  return new CollateralRejectedError();
}
