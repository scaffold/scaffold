// Protocol spec: docs/protocol/contracts.md (signature contract)

import type { ContractFn } from './ContractEnv.ts';

/**
 * Signature contract: verifies that the block was signed by the public
 * key specified in the verifier params.
 *
 * An output with SIGNATURE_CONTRACT + pubkey can only be claimed by a
 * block whose packet signature corresponds to that pubkey.
 */
export const signatureContract: ContractFn = (env) => {
  env.requireSignature(env.getParams());
};
