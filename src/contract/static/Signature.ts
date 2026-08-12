import { Hash } from '../../util/Hash.ts';
import { bin2hex } from '../../util/hex.ts';
import { secp } from '../../util/secp.ts';
import { Contract } from '../env/Contract.ts';

export const SIGNATURE_CONTRACT = Hash.digest('signature');

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

  debug(params) {
    let name = bin2hex(params);
    name = publicKeysToName.get(name) ?? name;
    return `signature(${name})`;
  },
};
