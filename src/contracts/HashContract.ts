// Protocol spec: docs/protocol/wasm-abi.md#stacking
//
// HASH_CONTRACT: content-addressed blob lookup beacon. A block publishing a
// blob carries:
//   1. A HASH_CONTRACT output whose verifier params are `hash(blob)` -- the
//      discovery key the network indexes on.
//   2. A RECORD_CONTRACT/'' output whose body is the blob -- what
//      `FetchManager.fetch` surfaces.
//
// The HASH_CONTRACT output is never claimed: it's a permanent UTXO acting as
// a discovery beacon. Callers verify `hash(body) === params` after fetching;
// the contract itself is a no-op (it would run only on a spend attempt, and
// nobody spends it).
//
// Why no on-block preimage verification: a contract's `run` cannot read
// sibling outputs of the executing block. The strict check has to live in
// the caller (e.g. `resolveBlob` in NodeContext) which sees the returned
// FetchResult.body and the requested hash together.

import { Hash } from '../util/Hash.ts';
import { HASH_CONTRACT, RECORD_CONTRACT } from '../core/Block.ts';
import type { Contract } from './Contract.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import { makeRecordOutput } from './RecordContract.ts';

/**
 * Build the outputs needed to publish a blob under HASH_CONTRACT:
 *   - HASH_CONTRACT/hash(blob) output (discovery beacon, body empty).
 *   - RECORD_CONTRACT/'' output (the blob bytes, surfaced by FetchManager).
 * Neither is self-claimed; the HASH_CONTRACT output stays unspent as a
 * permanent UTXO so future fetches can find the block.
 */
export function makeHashContractOutputs(blob: Uint8Array): Output[] {
  const blobHash = Hash.digest(blob);
  return [
    {
      verifier: { contract: HASH_CONTRACT, params: blobHash.toBytes() },
      value: 0,
      body: new Uint8Array(0),
    },
    makeRecordOutput('', blob),
  ];
}

/**
 * `run` is unreachable in normal use (HASH_CONTRACT outputs are never spent).
 * The implementation is a trivial accept so any accidental spend doesn't crash.
 */
export const hashContract: Contract = {
  outputNamespaces: [HASH_CONTRACT, RECORD_CONTRACT],
  run() {
    // No-op: discovery-beacon contract; preimage verification is caller-side.
  },
};
