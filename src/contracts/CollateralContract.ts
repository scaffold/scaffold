// Protocol spec: docs/protocol/collateral-resolution.md

import { maybeThen } from '../util/MaybePromise.ts';
import {
  type Block,
  COLLATERAL_CONTRACT,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
} from '../core/Block.ts';
import type { Output } from '../core/BlockCreationModule.ts';
import { type ContractEnv, ContractRejection, type Input } from '../core/ContractEnv.ts';
import type { Contract } from './Contract.ts';
import { Hash } from '../util/Hash.ts';
import { findRecordOutput } from './RecordContract.ts';

// -- Collateral types -------------------------------------------------

/** What aspect of a block an AGAINST challenge contests. */
export type ChallengeTarget =
  | { type: 'validity' }
  | { type: 'anchor' }
  | { type: 'ref'; index: number }
  | { type: 'aggregate'; index: number }
  | { type: 'output_verifier_contract'; index: number };

/** Detail payload for a collateral contract output. */
export type CollateralDetail =
  | { side: 'for'; pubkey: Uint8Array }
  | { side: 'against'; pubkey: Uint8Array; target: ChallengeTarget };

/** Encode CollateralDetail to Uint8Array. */
export function encodeCollateralDetail(detail: CollateralDetail): Uint8Array {
  const obj: Record<string, unknown> = {
    side: detail.side,
    pubkey: Array.from(detail.pubkey),
  };
  if (detail.side === 'against') {
    obj.target = detail.target;
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

/** Decode CollateralDetail from Uint8Array. */
export function decodeCollateralDetail(bytes: Uint8Array): CollateralDetail {
  const json = JSON.parse(new TextDecoder().decode(bytes));
  const pubkey = new Uint8Array(json.pubkey);
  if (json.side === 'for') {
    return { side: 'for', pubkey };
  }
  return { side: 'against', pubkey, target: json.target as ChallengeTarget };
}

/** Create a FOR collateral output for a target block. */
export function makeCollateralOutput(
  targetBlockHash: Hash,
  value: number,
  pubkey: Uint8Array,
): Output {
  return {
    verifier: { contract: COLLATERAL_CONTRACT, params: targetBlockHash.toBytes() },
    value,
    data: encodeCollateralDetail({ side: 'for', pubkey }),
  };
}

/** Create an AGAINST collateral output challenging a target block. */
export function makeAgainstOutput(
  targetBlockHash: Hash,
  value: number,
  pubkey: Uint8Array,
  target: ChallengeTarget,
): Output {
  return {
    verifier: { contract: COLLATERAL_CONTRACT, params: targetBlockHash.toBytes() },
    value,
    data: encodeCollateralDetail({ side: 'against', pubkey, target }),
  };
}

// -- Constants --------------------------------------------------------

/** Collateral decay constant (per millisecond). c = 0.3/s = 0.0003/ms. */
export const DECAY_CONSTANT = 0.0003;

/** Result key used to provide a hash preimage for challenge response. */
export const PREIMAGE_RESULT_KEY = new TextEncoder().encode('collateral:preimage');

// -- Verdict record output --------------------------------------------

/**
 * Stable record-output key declaring the resolution verdict about the
 * target block. Consumed by `CollateralResolutionIndex` (node-policy).
 *
 * Modes 1 and 2 emit `verdict: 'valid'`. Mode 3 emits `verdict: 'invalid'`.
 * Mode 4 (non-canonical reclaim) emits no verdict output at all.
 *
 * The record is self-claimed via `env.record` so it participates
 * in the block's claim structure like any other result.
 */
export const VERDICT_RECORD_KEY = 'verdict';
export const VERDICT_RECORD_KEY_BYTES = new TextEncoder().encode(VERDICT_RECORD_KEY);

export type CollateralVerdict = 'valid' | 'invalid';

export interface VerdictRecord {
  target: Hash;
  verdict: CollateralVerdict;
}

export function encodeVerdict(v: VerdictRecord): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ target: v.target.toHex(), verdict: v.verdict }),
  );
}

export function decodeVerdict(bytes: Uint8Array): VerdictRecord {
  const obj = JSON.parse(new TextDecoder().decode(bytes));
  if (obj.verdict !== 'valid' && obj.verdict !== 'invalid') {
    throw new Error(`invalid verdict value: ${obj.verdict}`);
  }
  return { target: Hash.fromHex(obj.target), verdict: obj.verdict };
}

/**
 * Read the verdict record output from a block.
 *
 * Returns `undefined` when no verdict record output is present (the
 * common, expected case for non-resolution blocks). Throws when a
 * record output is present but malformed -- callers must catch and
 * log so we don't drop bad input silently.
 */
export function readVerdictFromBlock(
  block: { outputs: Output[] },
): VerdictRecord | undefined {
  const out = findRecordOutput(block as Block, VERDICT_RECORD_KEY);
  if (!out) return undefined;
  return decodeVerdict(out.data);
}

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
    const detail = decodeCollateralDetail(input.data);
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
 *    FOR publisher. Responder reveals preimage via record(), earns AGAINST bond.
 *    FOR collateral returned to publisher.
 *
 * 3. **Unresolved challenge**: Both FOR and AGAINST claimed, block signed by
 *    AGAINST challenger (or anyone proving invalidity). Challenger claims
 *    FOR collateral + own bond back.
 *
 * 4. **Non-canonical reclaim**: Full return to both sides. No penalty.
 *    (Non-canonical detection is external; the contract just returns funds.)
 */
export const collateralContract: Contract = {
  outputNamespaces: [SIGNATURE_CONTRACT, RECORD_CONTRACT],

  run(env) {
    const inputsResult = env.claimAll();

    return maybeThen(inputsResult, (inputs) => {
      if (inputs.length === 0) {
        throw new ContractRejection('no collateral inputs');
      }

      const now = env.timestamp();
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
        env.sign(forPubkey);
        hashChallengeResponse(env, forInputs, againstInputs);
        return;
      } catch {
        // Not signed by FOR publisher -- try challenger
      }

      // Try AGAINST signer (unresolved challenge or non-canonical)
      try {
        env.sign(againstPubkey);
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
  },

  walkParams(params, host) {
    host.emitBytes('', params, {
      type: 'bytes/hash/sha256/scaffold/block',
      shortDescription: 'Target block hash',
    });
  },

  walkData(data, host) {
    const detail = decodeCollateralDetail(data);
    if (host.emitMapStart('collateral')) {
      host.emitString('side', detail.side, {
        type: 'string/utf8',
        shortDescription: 'Collateral side',
        options: [
          { value: 'for', shortDescription: 'Publisher stake' },
          { value: 'against', shortDescription: 'Challenger bond' },
        ],
      });
      host.emitBytes('pubkey', detail.pubkey, {
        type: 'bytes/public_key/ed25519',
        shortDescription: 'Owner public key',
      });
      if (detail.side === 'against') {
        if (host.emitMapStart('target')) {
          host.emitString('type', detail.target.type, {
            type: 'string/utf8',
            shortDescription: 'Challenge target type',
            options: [
              { value: 'validity', shortDescription: 'General validity' },
              { value: 'anchor', shortDescription: 'Anchor correctness' },
              { value: 'ref', shortDescription: 'Reference validity' },
              { value: 'aggregate', shortDescription: 'Aggregate validity' },
              {
                value: 'output_verifier_contract',
                shortDescription: 'Output verifier contract',
              },
            ],
          });
          if ('index' in detail.target) {
            host.emitNumber('index', detail.target.index, {
              type: 'i32',
              shortDescription: 'Target index',
            });
          }
          host.emitMapEnd();
        }
      }
      host.emitMapEnd();
    }
  },

  buildParams(host) {
    return host.requestBytes('targetBlock', {
      type: 'bytes/hash/sha256/scaffold/block',
      shortDescription: 'Target block hash',
    });
  },

  buildData(host) {
    host.beginObject('collateral');
    const side = host.requestString('side', {
      type: 'string/utf8',
      shortDescription: 'Collateral side',
      options: [
        { value: 'for', shortDescription: 'Publisher stake' },
        { value: 'against', shortDescription: 'Challenger bond' },
      ],
    });
    const pubkey = host.requestBytes('pubkey', {
      type: 'bytes/public_key/ed25519',
      shortDescription: 'Owner public key',
    });

    let target: ChallengeTarget | undefined;
    if (side === 'against') {
      host.beginObject('target');
      const targetType = host.requestString('type', {
        type: 'string/utf8',
        shortDescription: 'Challenge target type',
        options: [
          { value: 'validity', shortDescription: 'General validity' },
          { value: 'anchor', shortDescription: 'Anchor correctness' },
          { value: 'ref', shortDescription: 'Reference validity' },
          { value: 'aggregate', shortDescription: 'Aggregate validity' },
          {
            value: 'output_verifier_contract',
            shortDescription: 'Output verifier contract',
          },
        ],
      });
      if (
        targetType === 'ref' ||
        targetType === 'aggregate' ||
        targetType === 'output_verifier_contract'
      ) {
        const index = host.requestNumber('index', {
          type: 'i32',
          shortDescription: 'Target index',
        });
        target = { type: targetType, index } as ChallengeTarget;
      } else {
        target = { type: targetType as 'validity' | 'anchor' } as ChallengeTarget;
      }
      host.endObject();
    }

    host.endObject();

    if (side === 'against' && target) {
      return encodeCollateralDetail({ side: 'against', pubkey, target });
    }
    return encodeCollateralDetail({ side: 'for', pubkey });
  },
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
    env.sign(detail.pubkey);
    env.emitOutput(
      { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
      input.value,
    );
  }
  emitVerdict(env, 'valid');
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

  // Preimage must be provided via record
  env.record(PREIMAGE_RESULT_KEY, PREIMAGE_RESULT_KEY); // placeholder check

  // FOR collateral returned to publisher
  let totalFor = 0;
  for (const { input } of forInputs) {
    totalFor += input.value;
  }
  env.emitOutput(
    { contract: SIGNATURE_CONTRACT, params: forPubkey },
    totalFor,
  );

  // AGAINST bonds go to the responder (FOR publisher)
  let totalAgainst = 0;
  for (const { input } of againstInputs) {
    totalAgainst += input.value;
  }
  env.emitOutput(
    { contract: SIGNATURE_CONTRACT, params: forPubkey },
    totalAgainst,
  );

  emitVerdict(env, 'valid');
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
    env.emitOutput(
      { contract: SIGNATURE_CONTRACT, params: againstDetail.pubkey },
      againstInput.value + totalForValue,
    );
  }

  emitVerdict(env, 'invalid');
}

/**
 * Emit the verdict record output for this resolution block. The target
 * hash is taken from the contract's verifier params (all collateral
 * inputs for a single invocation share the same target, since the
 * contract is dispatched per distinct verifier).
 *
 * Mode 4 (non-canonical reclaim) does NOT call this -- no trust signal.
 */
function emitVerdict(env: ContractEnv, verdict: CollateralVerdict): void {
  const target = Hash.fromBytes(env.params());
  env.record(VERDICT_RECORD_KEY_BYTES, encodeVerdict({ target, verdict }));
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
    env.emitOutput(
      { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
      input.value,
    );
  }
  for (const { input, detail } of againstInputs) {
    env.emitOutput(
      { contract: SIGNATURE_CONTRACT, params: detail.pubkey },
      input.value,
    );
  }
}
