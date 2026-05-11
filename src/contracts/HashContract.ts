// Protocol spec: docs/protocol/wasm-abi.md#stacking
//
// HASH_CONTRACT: content-addressed blob lookup beacon and verifier.
// A block publishing a blob carries two outputs:
//   1. A HASH_CONTRACT output whose verifier params are `hash(blob)` -- the
//      discovery key the network indexes on. Self-claimed so its `run`
//      executes during verification (proving the preimage is valid).
//   2. A RECORD_CONTRACT/'default' output whose body is the blob -- what
//      `requestBody` reads during the contract's run, and what
//      `FetchManager.fetch(..., { recordKey: 'default' })` surfaces.
//
// The contract's run reads the 'default' record body and asserts
// hash(body) == verifier.params. A failing block is rejected; a passing
// one is a verified blob-publication that anyone can fetch by hash.

import { Hash } from '../util/Hash.ts';
import { HASH_CONTRACT, RECORD_CONTRACT } from '../core/Block.ts';
import { ContractRejection } from '../core/ContractEnv.ts';
import type { Contract } from './Contract.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import { makeRecordOutput } from './RecordContract.ts';
import { str2bin } from '../util/buffer.ts';

/** Record key on a HASH_CONTRACT block carrying the blob bytes. */
export const DEFAULT_KEY = 'default';

/**
 * Build the outputs needed to publish a blob under HASH_CONTRACT:
 *   - HASH_CONTRACT/hash(blob) discovery beacon (body empty).
 *   - RECORD_CONTRACT/'default' carrying the blob bytes.
 *
 * The caller is responsible for self-claiming BOTH outputs so verification
 * runs the HashContract (validates the preimage) and the RecordContract
 * (asserts the record is self-claimed).
 */
export function makeHashContractOutputs(blob: Uint8Array): Output[] {
  const blobHash = Hash.digest(blob);
  return [
    {
      verifier: { contract: HASH_CONTRACT, params: blobHash.toBytes() },
      value: 0,
      body: new Uint8Array(0),
    },
    makeRecordOutput(DEFAULT_KEY, blob),
  ];
}

export const hashContract: Contract = {
  // HashContract only VERIFIES (it reads the preimage record and checks the
  // hash); it does not own any output namespace. The block's record output
  // is owned by RecordContract's empty-namespace contract.
  outputNamespaces: [],

  async run(env) {
    if (env.params().length !== 32) {
      throw new ContractRejection(
        `HASH_CONTRACT verifier params must be 32 bytes, got ${env.params().length}`,
      );
    }
    const expectedHash = Hash.fromBytes(env.params());
    const { body: plaintext } = await env.requestBody({
      contract: RECORD_CONTRACT,
      params: str2bin(DEFAULT_KEY),
    });
    const actual = Hash.digest(plaintext);
    if (!Hash.equals(actual, expectedHash)) {
      throw new ContractRejection(
        `HASH_CONTRACT preimage mismatch: expected ${expectedHash.toHex()}, got ${actual.toHex()}`,
      );
    }
  },
};
