import { assert, error } from '../../util/functional.ts';
import { Hash, HASH_SIZE } from '../../util/Hash.ts';
import { hex2bin } from '../../util/hex.ts';
import { Contract } from '../env/Contract.ts';
import { ValueType } from '../values.ts';

export const EXACT_BLOCK_CONTRACT = Hash.digest('exact_block');

export const exactBlockContract: Contract = {
  run(env) {
    if (env.params().length !== HASH_SIZE) {
      throw new Error(
        `EXACT_BLOCK_CONTRACT verifier params must be ${HASH_SIZE} bytes, got ${env.params().length}`,
      );
    }
    const expected = Hash.fromBytes(env.params());
    if (!Hash.equals(env.blockHash(), expected)) {
      throw new Error(
        `EXACT_BLOCK_CONTRACT failure: block ${env.blockHash().toHex()} does not match ${expected.toHex()}`,
      );
    }
  },

  async buildParams(source) {
    const root = await source();
    const block = root.type === ValueType.Map
      ? (await root.at('block')) ?? error('ExactBlock params missing "block" property')
      : root;
    const bytes = block.type === ValueType.String
      ? hex2bin(block.value)
      : block.type === ValueType.Bytes
      ? block.value
      : error('ExactBlock params "block" property must be a string or bytes');
    if (bytes.byteLength !== HASH_SIZE) {
      throw new Error(
        `ExactBlock params "block" property must be ${HASH_SIZE} bytes, got ${bytes.byteLength}`,
      );
    }
    return bytes;
  },

  walkParams(params, sink) {
    const map = sink().setMap();
    map?.at('block').setBytes(params);
    map?.close();
  },

  debug(params) {
    return `exact_block(${Hash.fromBytes(params).toHex()})`;
  },
};
