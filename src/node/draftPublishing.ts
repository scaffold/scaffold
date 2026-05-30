// Shared helpers for the user-facing publishing primitives (PutManager,
// SendManager, FetchManager). They centralize the params-encoding path so the
// managers stay in lockstep.

import { Hash } from '../util/Hash.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { str2bin } from '../util/buffer.ts';

/**
 * Encode a `params` field that may already be bytes or may be a plain object.
 *
 * Object params are encoded as **canonical JSON** (recursively sorted keys, so
 * the same logical params always produce the same verifier bytes -- important
 * because verifier params are content-addressed). This matches the JS runtime,
 * whose contracts read params via `JSON.parse(scaffold.params())`.
 *
 * Contracts that need a custom binary encoding should pass `params` as a
 * `Uint8Array`. (A declarative per-contract codec -- the generic JSON
 * walker/builder module that lets any contract advertise its params shape --
 * is tracked as future work in TODO.md.)
 */
export function encodeParams(
  contractHash: Hash,
  params: Uint8Array | Record<string, unknown>,
  contractHost: ContractHostService,
): Uint8Array {
  if (params instanceof Uint8Array) return params;
  if (!contractHost.getContract(contractHash)) {
    throw new Error(`contract not registered: ${contractHash.toHex()}`);
  }
  return str2bin(canonicalJson(params));
}

/**
 * JSON with recursively sorted object keys, for stable content addressing.
 * Arrays keep their order; `Uint8Array` is left for `JSON.stringify`'s default
 * handling (callers should pass bytes via the `Uint8Array` params path).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}
