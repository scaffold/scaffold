// Protocol spec: docs/protocol/wasm-abi.md#stacking
//
// HASH_CONTRACT: content-addressed blob verifier. The verifier params are
// the 32-byte hash of a blob; the publishing block carries a
// RECORD_CONTRACT/'default' output whose body IS the blob. When the
// HASH_CONTRACT output is claimed (typically the incentive output sits on
// a request block, claimed by a responder publishing the blob),
// `hashContract.run` reads the 'default' record via `env.request` and
// asserts `hash(body) == verifier.params`.
//
// Other contracts invert a hash by calling
//   `await fetch({ contract: HASH_CONTRACT, params: hash, key: 'default' })`
// which surfaces the body.
//
// outputNamespaces = [RECORD_CONTRACT]: `request({contract: RECORD_CONTRACT, ...})`
// emits an output slot on the block being verified, which contributes a
// RECORD_CONTRACT-namespace output. The partition check requires the
// contract to OWN every namespace whose outputs appear -- so we declare it.

import { Hash } from '../util/Hash.ts';
import { RECORD_CONTRACT } from '../core/Block.ts';
import { ContractRejection } from '../core/ContractEnv.ts';
import type { Contract } from './Contract.ts';

export const hashContract: Contract = {
  // request adds a RECORD_CONTRACT slot; partition requires HASH_CONTRACT
  // owns that namespace on this block.
  outputNamespaces: [RECORD_CONTRACT],

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
