// Protocol spec: docs/protocol/contracts.md (record contract)

import { type Block, RECORD_CONTRACT } from '../core/Block.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import { ContractRejection } from '../core/ContractEnv.ts';
import type { Contract } from './Contract.ts';
import { Hash } from '../util/Hash.ts';

/**
 * Create a record (key-value) output. Record outputs use the RECORD_CONTRACT
 * verifier with the key encoded in params. They act as a key-value store
 * within a block and are always self-claimed.
 */
export function makeRecordOutput(key: string | Uint8Array, value: Uint8Array): Output {
  const params = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  return {
    verifier: { contract: RECORD_CONTRACT, params },
    value: 0,
    data: value,
  };
}

/** Check whether an output is a record output (uses RECORD_CONTRACT). */
export function isRecordOutput(output: Output): boolean {
  return Hash.equals(output.verifier.contract, RECORD_CONTRACT);
}

/** Get the key from a record output's verifier params. */
export function getRecordKey(output: Output): Uint8Array {
  return output.verifier.params;
}

/** Find the first record output in a block matching the given key. */
export function findRecordOutput(block: Block, key: string | Uint8Array): Output | undefined {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  for (const output of block.outputs) {
    if (!isRecordOutput(output)) continue;
    const params = output.verifier.params;
    if (params.length === keyBytes.length && params.every((b, i) => b === keyBytes[i])) {
      return output;
    }
  }
  return undefined;
}

/**
 * Record contract: key-value outputs that are always self-claimed.
 *
 * Verifies that every input is a self-claim (the claimed output belongs
 * to the same block that is claiming it).
 */
export const recordContract: Contract = {
  async run(env) {
    const inputs = await env.collectInputs();
    for (const input of inputs) {
      if (!input.isSelfClaim) {
        throw new ContractRejection('record outputs must be self-claimed');
      }
    }
  },
};
