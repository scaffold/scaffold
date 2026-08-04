// Protocol spec: docs/design/fetch.md

/**
 * A newer canonical claim surfaced different data. Rejected from the prior
 * FetchResult's `parse()` promise so callers awaiting it can discover that
 * a fresher value is on the way.
 */
export class SupersededError extends Error {
  constructor(message = 'fetch result superseded by a newer canonical claim') {
    super(message);
    this.name = 'SupersededError';
  }
}

/**
 * The claim that produced this FetchResult was invalidated and no replacement
 * canonical claim exists for the verifier. The caller's onResult / onClaim
 * will (or did) fire with null in the same cycle.
 */
export class InvalidatedError extends Error {
  constructor(message = 'fetch result invalidated with no replacement') {
    super(message);
    this.name = 'InvalidatedError';
  }
}

/**
 * Local contract verification rejected a candidate responder block. For
 * verify:true fetches, this means we keep waiting for the next canonical
 * claimant; the caller's Promise is not rejected by a single verification
 * failure. Surfaced via onError for streaming fetches.
 */
export class VerificationRejectedError extends Error {
  constructor(message = 'response contract rejected the claimant block') {
    super(message);
    this.name = 'VerificationRejectedError';
  }
}

/**
 * A feature that is declared in the API but deferred to a later phase. For
 * Phase 4 this covers publish:false (depends on local-only piggyback).
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/**
 * The fetch was cancelled via an AbortSignal before a result arrived.
 * verify:true Promises reject with this.
 */
export class FetchAbortError extends Error {
  constructor(message = 'fetch aborted') {
    super(message);
    this.name = 'FetchAbortError';
  }
}
