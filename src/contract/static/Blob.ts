import { str2bin } from '../../util/buffer.ts';
import { assert, error } from '../../util/functional.ts';
import { Hash, HASH_SIZE } from '../../util/Hash.ts';
import { hex2bin } from '../../util/hex.ts';
import { Contract } from '../env/Contract.ts';
import { ValueType } from '../values.ts';

export const BLOB_CONTRACT = Hash.digest('blob');

export const blobContract: Contract = {
  run(env) {
    if (env.params().length !== HASH_SIZE) {
      throw new Error(
        `BLOB_CONTRACT verifier params must be ${HASH_SIZE} bytes, got ${env.params().length}`,
      );
    }
    const expected = Hash.fromBytes(env.params());
    const actual = Hash.digest(env.getResult());
    if (!Hash.equals(actual, expected)) {
      throw new Error(
        `BLOB_CONTRACT preimage mismatch: expected ${expected.toHex()}, got ${actual.toHex()}`,
      );
    }
  },

  async buildParams(source) {
    const root = await source();
    const hash = root.type === ValueType.Map
      ? (await root.at('hash')) ?? error('Blob params missing "hash" property')
      : root;
    const bytes = hash.type === ValueType.String
      ? hex2bin(hash.value)
      : hash.type === ValueType.Bytes
      ? hash.value
      : error('Blob params "hash" property must be a string or bytes');
    if (bytes.byteLength !== HASH_SIZE) {
      throw new Error(
        `Blob params "hash" property must be ${HASH_SIZE} bytes, got ${bytes.byteLength}`,
      );
    }
    return bytes;
  },

  walkParams(params, sink) {
    const map = sink().setMap();
    map?.at('hash').setBytes(params);
    map?.close();
  },

  // The body is the preimage itself, so it lives at the root rather than in a named field.
  async buildBody(source) {
    const root = await source();
    return root.type === ValueType.String
      ? str2bin(root.value)
      : root.type === ValueType.Bytes
      ? root.value
      : error('Blob body must be a string or bytes');
  },

  walkBody(body, sink) {
    sink().setBytes(body);
  },

  debug(params) {
    return `blob(${Hash.fromBytes(params).toHex()})`;
  },
};
