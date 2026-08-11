import { Hash } from '../../util/Hash.ts';
import { Contract } from '../env/Contract.ts';

export const EXACT_BLOCK_CONTRACT = Hash.digest('exact_block');

export const exactBlockContract: Contract = {
  run(env) {
    if (env.params().length !== 32) {
      throw new Error(
        `EXACT_BLOCK_CONTRACT verifier params must be 32 bytes, got ${env.params().length}`,
      );
    }
    const expected = Hash.fromBytes(env.params());
    if (!Hash.equals(env.blockHash(), expected)) {
      throw new Error(
        `EXACT_BLOCK_CONTRACT failure: block ${env.blockHash().toHex()} does not match ${expected.toHex()}`,
      );
    }
  },

  debug(params) {
    return `exact_block(${Hash.fromBytes(params).toHex()})`;
  },
};
