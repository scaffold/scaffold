// Protocol spec: docs/protocol/collateral-resolution.md

import { maybeThen } from '../util/MaybePromise.ts';
import {
  decodeInsuranceDetail,
  encodeInsuranceDetail,
  type InsuranceDetail,
  SIGNATURE_CONTRACT,
} from './Block.ts';
import { ContractRejection } from './ContractEnv.ts';
import type { Contract } from './Contract.ts';

// -- Constants --------------------------------------------------------

/** Finder's share of insurance payout (alpha). */
export const FINDER_SHARE = 0.5;

/**
 * Minimum fraction of the deposit that must be returned to the author
 * during aggregation claim. (1 - maxFeeRate) * deposit is the minimum return.
 * A 5% max fee means at least 95% is returned.
 */
export const MIN_RETURN_RATE = 0.95;

// -- Contract ---------------------------------------------------------

/**
 * Insurance contract: handles risk transfer between block authors and aggregators.
 *
 * Resolution modes:
 *
 * 1. **Aggregation claim**: Aggregator claims author's insurance deposit.
 *    Must return at least MIN_RETURN_RATE * deposit to the author.
 *    The difference is the aggregation fee.
 *
 * 2. **Rectification payout**: Invalid block proven. Finder gets alpha * pot,
 *    remainder goes to victim restoration.
 *
 * 3. **Solidification return**: Aggregator reclaims after sufficient time.
 *    Requires aggregator signature. Full value returned.
 *
 * 4. **Non-canonical reclaim**: Full return to owner.
 */
export const insuranceContract: Contract = {
  run(env) {
    const inputsResult = env.collectInputs();

    return maybeThen(inputsResult, (inputs) => {
      if (inputs.length === 0) {
        throw new ContractRejection('no insurance inputs');
      }

      const now = env.getTimestamp();
      const input = inputs[0];
      const detail = decodeInsuranceDetail(input.data);

      // The resolution mode is determined by what outputs the claiming block produces.
      // The contract enforces the minimum return to the original author.
      //
      // If the claiming block is signed by the owner (author or aggregator),
      // it's a solidification return or non-canonical reclaim.
      // Otherwise, it's an aggregation claim (must return most to author).
      //
      // For aggregation claim: require output returning at least MIN_RETURN_RATE * deposit.
      // For rectification: require finder reward + victim restoration outputs.
      // For solidification/reclaim: require full return to owner.

      // Check if signed by the insurance owner (solidification or non-canonical reclaim)
      try {
        env.requireSignature(detail.pubkey);
        // Owner is reclaiming -- full return
        env.requireOutput(
          { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
          input.value,
        );
        return;
      } catch {
        // Not signed by owner -- aggregation claim or rectification
      }

      // Aggregation claim: someone else claiming, must return most to author
      const minReturn = Math.floor(input.value * MIN_RETURN_RATE);
      env.requireOutput(
        { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
        minReturn,
      );
    });
  },

  walkParams(params, host) {
    host.emitBytes('', params, {
      type: 'bytes/hash/sha256/scaffold/block',
      shortDescription: 'Target block hash',
    });
  },

  walkData(data, host) {
    const detail = decodeInsuranceDetail(data);
    host.emitBytes('pubkey', detail.pubkey, {
      type: 'bytes/public_key/ed25519',
      shortDescription: 'Owner public key',
    });
  },

  buildParams(host) {
    return host.requestBytes('targetBlock', {
      type: 'bytes/hash/sha256/scaffold/block',
      shortDescription: 'Target block hash',
    });
  },

  buildData(host) {
    const pubkey = host.requestBytes('pubkey', {
      type: 'bytes/public_key/ed25519',
      shortDescription: 'Owner public key',
    });
    return encodeInsuranceDetail({ pubkey });
  },
};

export { type InsuranceDetail };
