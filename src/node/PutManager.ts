// User-facing draft API: the three publishing primitives.
//
// - `put({contract, params, records})` publishes a verifier output under
//   `(contract, params)` together with one RECORD_CONTRACT output per
//   entry in `records`. Companion to `Scaffold.fetch`: subsequent fetches
//   on the same verifier surface those records.
// - `send({contract, params, body})` publishes a single output under
//   `(contract, params)` with the supplied body. Fire-and-forget.
//
// Both routes feed into DraftManager. The draft is an intent to create a
// possibly canonical block; if the block becomes uncanonical the draft
// pipeline re-creates another. See docs/protocol/draft-blocks.md.
//
// `put` does not require canonicality. `send` requires canonicality (the
// peer the output is sent to must observe a canonical chain to act on it).

import { AGGREGATION_CONTRACT, Block, RECORD_CONTRACT } from '../core/Block.ts';
import { makeAggregationOutput } from '../contracts/AggregationContract.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { DraftManager } from '../core/DraftManager.ts';
import { ContractHostService } from '../core/ContractHostService.ts';
import { DefaultBuilderHost } from '../core/DefaultBuilderHost.ts';
import { Hash } from '../util/Hash.ts';
import { str2bin } from '../util/buffer.ts';

/** Publish records under a verifier. Does not require canonicality. */
export interface PutRequest {
  /** Verifier-output contract hash. */
  contract: Hash;
  /**
   * Verifier-output params. Pre-encoded bytes, or a key-value object that
   * `contract.buildParams` will encode (requires the contract to be
   * registered).
   */
  params: Uint8Array | Record<string, unknown>;
  /**
   * Records to publish on the same block. Each entry becomes a
   * RECORD_CONTRACT output whose `verifier.params = utf8(key)` and
   * `body = utf8(value)`.
   */
  records: Record<string, Uint8Array | string>;
}

/** Publish a single output under a verifier. Requires canonicality. */
export interface SendRequest {
  /** Output's verifier contract hash. */
  contract: Hash;
  /**
   * Output's verifier params. Pre-encoded bytes, or a key-value object
   * that `contract.buildParams` will encode.
   */
  params: Uint8Array | Record<string, unknown>;
  /** Output body. */
  body: Uint8Array;
  /** Output value (economic weight on the wire). Default 0. */
  value?: number;
}

export class PutManager {
  constructor(
    private readonly draftManager: DraftManager,
    private readonly contractHost: ContractHostService,
  ) {}

  /**
   * Publish a verifier with fitting records on a new draft. The draft is
   * solidified immediately if a canonical anchor is available; otherwise
   * the draft pipeline retries as the chain advances. Does not require
   * canonicality of the resulting block.
   */
  put(request: PutRequest): void {
    const params = encodeParams(request.contract, request.params, this.contractHost);
    const outputs: Output[] = [
      // Verifier marker output: makes the block discoverable as the
      // publisher of `(contract, params)`. Body-less so it's pure
      // incentive / signal, not data.
      { verifier: { contract: request.contract, params }, value: 0 },
    ];
    for (const [key, value] of Object.entries(request.records)) {
      outputs.push({
        verifier: { contract: RECORD_CONTRACT, params: str2bin(key) },
        value: 0,
        body: typeof value === 'string' ? str2bin(value) : value,
      });
    }
    outputs.push(makeAggregationOutput());

    const draft = this.draftManager.addReady({
      claims: [],
      outputs,
      declaredWeight: 1,
    });
    this.draftManager.solidify([draft]);
  }

  /**
   * Publish a single output under the supplied verifier and return. The
   * draft pipeline handles canonicality / re-creation on uncanonical.
   */
  send(request: SendRequest): void {
    const params = encodeParams(request.contract, request.params, this.contractHost);
    const outputs: Output[] = [
      {
        verifier: { contract: request.contract, params },
        value: request.value ?? 0,
        body: request.body,
      },
      makeAggregationOutput(),
    ];
    const draft = this.draftManager.addReady({
      claims: [],
      outputs,
      declaredWeight: 1,
    });
    this.draftManager.solidify([draft]);
  }
}

// -- Helpers ---------------------------------------------------------

function encodeParams(
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

// AGGREGATION_CONTRACT and Block re-exports for downstream callers that
// still rely on the old surface; remove once no consumer imports them
// from this file.
export type { Block };
export { AGGREGATION_CONTRACT };
