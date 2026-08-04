// Protocol spec: docs/protocol/results.md, docs/protocol/wasm-abi.md#stacking
//
// HASH_CONTRACT: content-addressed blob verifier. The verifier params are
// the 32-byte hash of a blob; the publishing block self-claims an ANSWER
// output `{ HASH_CONTRACT, hash, data: blob }` (the data-based result model).
// When the HASH_CONTRACT output is claimed (typically the incentive output
// sits on a request block, claimed by a responder publishing the blob),
// `hashContract.run` reads the blob via `env.getResult()` (host-supplied,
// committed as the answer) and asserts `hash(blob) == verifier.params`.
//
// Other contracts invert a hash by calling
//   `await fetch({ contract: HASH_CONTRACT, params: hash })`
// which surfaces the answer body.
//
// outputNamespaces = [HASH_CONTRACT]: getResult emits a self-claimed answer
// under the running verifier (contract HASH_CONTRACT). The partition check
// requires the contract to OWN every namespace whose outputs appear -- so we
// declare our own hash (self-namespacing). See docs/protocol/results.md.

import { Hash } from '../util/Hash.ts';
import { HASH_CONTRACT } from '../core/Block.ts';
import { ContractRejection } from '../core/ContractEnv.ts';
import type { Contract } from './Contract.ts';

/**
 * Conventional record key for the deprecated record-based result surface,
 * still used by the not-yet-migrated JS compiler / contract-registration path
 * (and the local blob scan). Kept exported here as the historical home.
 */
export const DEFAULT_KEY = 'default';

export const hashContract: Contract = {
  // getResult emits a self-claimed answer under HASH_CONTRACT; partition
  // requires the contract to own that namespace on this block.
  outputNamespaces: [HASH_CONTRACT],

  async run(env) {
    if (env.params().length !== 32) {
      throw new ContractRejection(
        `HASH_CONTRACT verifier params must be 32 bytes, got ${env.params().length}`,
      );
    }
    const expected = Hash.fromBytes(env.params());
    const actual = Hash.digest(await env.getResult());
    if (!Hash.equals(actual, expected)) {
      throw new ContractRejection(
        `HASH_CONTRACT preimage mismatch: expected ${expected.toHex()}, got ${actual.toHex()}`,
      );
    }
  },
};
