import { assert, error } from '../../util/functional.ts';
import { Hash } from '../../util/Hash.ts';
import { bin2hex, hex2bin } from '../../util/hex.ts';
import { secp } from '../../util/secp.ts';
import { Contract } from '../env/Contract.ts';
import { ValueType } from '../values.ts';

export const SIGNATURE_CONTRACT = Hash.digest('signature');

// Compressed secp256k1, matching the keys `env.sign` takes.
const PUBLIC_KEY_BYTES = 33;

// These match the outputs that the genesis block creates
const publicKeysToName = new Map(['alice', 'bob', 'charlie'].map(
  (name) => [
    bin2hex(secp.getPublicKey(Hash.digest(`scaffold:testnet:${name}`).toBytes(), true)),
    name,
  ],
));

export const signatureContract: Contract = {
  run(env) {
    env.sign(env.params());
  },

  async buildParams(source) {
    const root = await source();
    const publicKey = root.type === ValueType.Map
      ? (await root.at('publicKey')) ?? error('Signature params missing "publicKey" property')
      : root;
    const bytes = publicKey.type === ValueType.String
      ? hex2bin(publicKey.value)
      : publicKey.type === ValueType.Bytes
      ? publicKey.value
      : error('Signature params "publicKey" property must be a string or bytes');
    if (bytes.byteLength !== PUBLIC_KEY_BYTES) {
      throw new Error(
        `Signature params "publicKey" property must be ${PUBLIC_KEY_BYTES} bytes, got ${bytes.byteLength}`,
      );
    }
    return bytes;
  },

  walkParams(params, sink) {
    const map = sink().setMap();
    map?.at('publicKey').setBytes(params);
    map?.close();
  },

  debug(params) {
    let name = bin2hex(params);
    name = publicKeysToName.get(name) ?? name;
    return `signature(${name})`;
  },
};
