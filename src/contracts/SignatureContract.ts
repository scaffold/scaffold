// Protocol spec: docs/protocol/contracts.md (signature contract)

import { SIGNATURE_CONTRACT } from '../core/Block.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import type { Contract } from './Contract.ts';

/**
 * Create a signature (payment) contract output.
 * Public key goes in verifier.params (33-byte compressed secp256k1).
 */
export function makeSignatureOutput(publicKey: Uint8Array, value: number): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: publicKey },
    value,
    data: new Uint8Array(0),
  };
}

/**
 * Signature contract: verifies that the block was signed by the public
 * key specified in the verifier params.
 *
 * An output with SIGNATURE_CONTRACT + pubkey can only be claimed by a
 * block whose packet signature corresponds to that pubkey.
 */
export const signatureContract: Contract = {
  outputNamespaces: [],

  run(env) {
    env.sign(env.params());
  },

  walkParams(params, host) {
    host.emitBytes('', params, {
      type: 'bytes/public_key/ed25519',
      shortDescription: 'Owner public key',
    });
  },

  buildParams(host) {
    const pk = host.requestBytes('publicKey', {
      type: 'bytes/public_key/ed25519',
      shortDescription: 'Owner public key',
    });
    if (pk.length > 0 && pk.length !== 33) {
      host.validationError('publicKey', 'Public key must be 33 bytes');
    }
    return pk;
  },
};
