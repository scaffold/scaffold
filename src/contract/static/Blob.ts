import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';

export const BLOB_CONTRACT = Hash.digest('blob');

export const blobContract: Contract = {
  async run(env) {
    if (env.params().length !== 32) {
      throw new Error(
        `BLOB_CONTRACT verifier params must be 32 bytes, got ${env.params().length}`,
      );
    }
    const expected = Hash.fromBytes(env.params());
    const actual = Hash.digest(await env.getResult());
    if (!Hash.equals(actual, expected)) {
      throw new Error(
        `BLOB_CONTRACT preimage mismatch: expected ${expected.toHex()}, got ${actual.toHex()}`,
      );
    }
  },

  debug(params) {
    return `blob(${Hash.fromBytes(params).toHex()})`;
  },
};
