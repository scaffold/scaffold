// Shared helpers for the user-facing publishing primitives (PutManager,
// SendManager). Both build outputs to feed `DraftManager.addReady`; the
// helpers below normalize their inputs and centralize the params-encoding
// path so the two managers stay in lockstep.

import { Hash } from '../util/Hash.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { DefaultBuilderHost } from '../core/DefaultBuilderHost.ts';

/**
 * Encode a `params` field that may already be bytes or may be a key-value
 * object that the contract knows how to serialize via `buildParams`. Used
 * by both PutManager and SendManager and mirrors what FetchManager does for
 * its own `params`.
 */
export function encodeParams(
  contractHash: Hash,
  params: Uint8Array | Record<string, unknown>,
  contractHost: ContractHostService,
): Uint8Array {
  if (params instanceof Uint8Array) return params;
  const contract = contractHost.getContract(contractHash);
  if (!contract) {
    throw new Error(`contract not registered: ${contractHash.toHex()}`);
  }
  if (!contract.buildParams) {
    throw new Error(
      `contract ${contractHash.toHex()} does not support buildParams; ` +
        'pass params as Uint8Array',
    );
  }
  const values = flatten(params);
  const host = new DefaultBuilderHost(values);
  const result = contract.buildParams(host);
  if (result instanceof Promise) {
    throw new Error(
      `contract ${contractHash.toHex()}: buildParams returned a Promise; ` +
        'put()/send() require synchronous buildParams. Pass params as a Uint8Array.',
    );
  }
  return result;
}

function flatten(
  obj: Record<string, unknown>,
  prefix = '',
  out = new Map<string, unknown>(),
): Map<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, key, out);
    } else if (Array.isArray(v)) {
      out.set(key, v.length);
      for (let i = 0; i < v.length; i++) {
        const el = v[i];
        const elKey = `${key}.${i}`;
        if (el !== null && typeof el === 'object' && !(el instanceof Uint8Array)) {
          flatten(el as Record<string, unknown>, elKey, out);
        } else {
          out.set(elKey, el);
        }
      }
    } else {
      out.set(key, v);
    }
  }
  return out;
}
