// Protocol spec: docs/protocol/computation.md#host-handler-registration

import type { OutputHandler } from './OutputHandlerRegistry.ts';

/**
 * Stub resolver for hash-lock / blob registry lookups. When the requested
 * output's verifier is a hash-lock contract, a real implementation would
 * return the stored preimage data. Returns null for now; real blob
 * registry wiring lands as a follow-up.
 *
 * TODO(@joel): implement real blob-registry lookup. Probably keyed by
 * the hash in `outputVerifier.params`.
 */
export function makeBlobRegistryResolver(): OutputHandler {
  return async (_runningParams, _outputVerifier) => null;
}

/**
 * Stub resolver for UTXO-sourced `requestBody` calls. Some contracts may want
 * to request outputs that already exist on the chain (e.g., aggregation
 * contracts that want to bind to existing markers). Returns null for now.
 *
 * TODO(@joel): scope and implement. The naive version would look up the
 * verifier in UtxoIndex and surface value/data from a canonical output.
 */
export function makeUtxoResolver(): OutputHandler {
  return async (_runningParams, _outputVerifier) => null;
}
