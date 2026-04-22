// Errors surfaced by TrustGate.awaitTrusted.

export class VerificationRejectedError extends Error {
  constructor(reason: string) {
    super(`verification rejected: ${reason}`);
    this.name = 'VerificationRejectedError';
  }
}

export class CollateralRejectedError extends Error {
  constructor() {
    super('block rejected by collateral resolution verdict');
    this.name = 'CollateralRejectedError';
  }
}

export class TrustTimeoutError extends Error {
  constructor(ms: number) {
    super(`trust gate timed out after ${ms}ms`);
    this.name = 'TrustTimeoutError';
  }
}
