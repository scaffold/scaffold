// Protocol spec: docs/protocol/contracts.md (signature contract)

import type { Contract } from './Contract.ts';

/**
 * Signature contract: verifies that the block was signed by the public
 * key specified in the verifier params.
 *
 * An output with SIGNATURE_CONTRACT + pubkey can only be claimed by a
 * block whose packet signature corresponds to that pubkey.
 */
export const signatureContract: Contract = {
  run(env) {
    env.requireSignature(env.getParams());
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
