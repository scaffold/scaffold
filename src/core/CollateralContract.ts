// Protocol spec: docs/protocol/collateral-resolution.md

import { Hash } from '../util/Hash.ts';
import { type MaybePromise, maybeThen } from '../util/MaybePromise.ts';
import {
  RESULT_CONTRACT,
  SIGNATURE_CONTRACT,
  type ChallengeTarget,
  type CollateralDetail,
  decodeCollateralDetail,
} from './Block.ts';
import {
  type ContractEnv,
  type ContractFn,
  ContractRejection,
  type Input,
} from './ContractEnv.ts';
import type { Verifier } from './BlockCreationModule.ts';

// -- Constants --------------------------------------------------------

/** Collateral decay constant (per millisecond). c = 0.3/s = 0.0003/ms. */
export const DECAY_CONSTANT = 0.0003;

/** Result key used to provide a hash preimage for challenge response. */
export const PREIMAGE_RESULT_KEY = new TextEncoder().encode('collateral:preimage');

// -- Helpers ----------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Compute decayed collateral value. */
export function decayedValue(initialValue: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return initialValue;
  return initialValue * Math.exp(-DECAY_CONSTANT * elapsedMs);
}

// -- Partition inputs -------------------------------------------------

interface PartitionedInputs {
  forInputs: { input: Input; detail: CollateralDetail & { side: 'for' } }[];
  againstInputs: { input: Input; detail: CollateralDetail & { side: 'against' } }[];
}

function partitionInputs(inputs: Input[]): PartitionedInputs {
  const forInputs: PartitionedInputs['forInputs'] = [];
  const againstInputs: PartitionedInputs['againstInputs'] = [];

  for (const input of inputs) {
    const detail = decodeCollateralDetail(input.detail);
    if (detail.side === 'for') {
      forInputs.push({
        input,
        detail: detail as CollateralDetail & { side: 'for' },
      });
    } else {
      againstInputs.push({
        input,
        detail: detail as CollateralDetail & { side: 'against' },
      });
    }
  }

  return { forInputs, againstInputs };
}

// -- Contract ---------------------------------------------------------

/**
 * Collateral contract: handles FOR/AGAINST validity stakes on a target block.
 *
 * Resolution modes (determined by which inputs are claimed and block signer):
 *
 * 1. **Decay return**: Only FOR claimed, no AGAINST exists.
 *    Publisher reclaims FOR value. Requires publisher signature.
 *
 * 2. **Hash challenge response**: Both FOR and AGAINST claimed, block signed by
 *    FOR publisher. Responder reveals preimage via requireResult(), earns AGAINST bond.
 *    FOR collateral returned to publisher.
 *
 * 3. **Unresolved challenge**: Both FOR and AGAINST claimed, block signed by
 *    AGAINST challenger (or anyone proving invalidity). Challenger claims
 *    FOR collateral + own bond back.
 *
 * 4. **Non-canonical reclaim**: Full return to both sides. No penalty.
 *    (Non-canonical detection is external; the contract just returns funds.)
 */
export const collateralContract: ContractFn = (env) => {
  const inputsResult = env.collectInputs();

  return maybeThen(inputsResult, (inputs) => {
    if (inputs.length === 0) {
      throw new ContractRejection('no collateral inputs');
    }

    const now = env.getTimestamp();
    const { forInputs, againstInputs } = partitionInputs(inputs);

    if (forInputs.length === 0) {
      throw new ContractRejection('no FOR collateral found');
    }

    if (againstInputs.length === 0) {
      // Mode 1: Decay return
      decayReturn(env, forInputs);
      return;
    }

    // FOR and AGAINST both present. Determine who is claiming.
    // If signed by FOR pubkey -> hash challenge response (mode 2)
    // If signed by AGAINST pubkey -> unresolved challenge (mode 3)
    // Non-canonical reclaim (mode 4) returns full value to both sides.
    const forPubkey = forInputs[0].detail.pubkey;
    const againstPubkey = againstInputs[0].detail.pubkey;

    // Try FOR signer first (hash challenge response)
    try {
      env.requireSignature(forPubkey);
      hashChallengeResponse(env, forInputs, againstInputs);
      return;
    } catch {
      // Not signed by FOR publisher -- try challenger
    }

    // Try AGAINST signer (unresolved challenge or non-canonical)
    try {
      env.requireSignature(againstPubkey);
      unresolvedChallenge(env, forInputs, againstInputs);
      return;
    } catch {
      // Not signed by AGAINST challenger either
    }

    // Neither FOR nor AGAINST signer -- could be non-canonical reclaim by either side
    // or an unrelated party. For non-canonical reclaim, accept any signer and return
    // full value to both sides.
    nonCanonicalReclaim(env, forInputs, againstInputs);
  });
};

// -- Resolution modes -------------------------------------------------

/**
 * Mode 1: Decay return. No AGAINST challenges exist.
 * Publisher reclaims the FOR value via signature check.
 */
function decayReturn(
  env: ContractEnv,
  forInputs: PartitionedInputs['forInputs'],
): void {
  for (const { input, detail } of forInputs) {
    env.requireSignature(detail.pubkey);
    env.requireOutput(
      { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
      input.value,
    );
  }
}

/**
 * Mode 2: Hash challenge response. Block signed by FOR publisher.
 * Responder reveals preimage, earns AGAINST bond. FOR returned to publisher.
 */
function hashChallengeResponse(
  env: ContractEnv,
  forInputs: PartitionedInputs['forInputs'],
  againstInputs: PartitionedInputs['againstInputs'],
): void {
  const forPubkey = forInputs[0].detail.pubkey;

  // Preimage must be provided via requireResult
  env.requireResult(PREIMAGE_RESULT_KEY, PREIMAGE_RESULT_KEY); // placeholder check

  // FOR collateral returned to publisher
  let totalFor = 0;
  for (const { input } of forInputs) {
    totalFor += input.value;
  }
  env.requireOutput(
    { contract: SIGNATURE_CONTRACT, params: forPubkey },
    totalFor,
  );

  // AGAINST bonds go to the responder (FOR publisher)
  let totalAgainst = 0;
  for (const { input } of againstInputs) {
    totalAgainst += input.value;
  }
  env.requireOutput(
    { contract: SIGNATURE_CONTRACT, params: forPubkey },
    totalAgainst,
  );
}

/**
 * Mode 3: Unresolved challenge. Block signed by AGAINST challenger.
 * Challenger claims FOR collateral + own bond back.
 */
function unresolvedChallenge(
  env: ContractEnv,
  forInputs: PartitionedInputs['forInputs'],
  againstInputs: PartitionedInputs['againstInputs'],
): void {
  let totalForValue = 0;
  for (const { input } of forInputs) {
    totalForValue += input.value;
  }

  for (const { input: againstInput, detail: againstDetail } of againstInputs) {
    env.requireOutput(
      { contract: SIGNATURE_CONTRACT, params: againstDetail.pubkey },
      againstInput.value + totalForValue,
    );
  }
}

/**
 * Mode 4: Non-canonical reclaim. Full return to both sides.
 */
function nonCanonicalReclaim(
  env: ContractEnv,
  forInputs: PartitionedInputs['forInputs'],
  againstInputs: PartitionedInputs['againstInputs'],
): void {
  for (const { input, detail } of forInputs) {
    env.requireOutput(
      { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
      input.value,
    );
  }
  for (const { input, detail } of againstInputs) {
    env.requireOutput(
      { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
      input.value,
    );
  }
}

export { type CollateralDetail, type ChallengeTarget };
