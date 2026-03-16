// Protocol spec: docs/protocol/anchoring.md

import { Hash } from '../util/Hash.ts';
import { BitVector } from './BitVector.ts';

/**
 * A semantic claim against a specific block's output.
 * Unlike integer claim indices (which are positional and become stale when
 * the graph changes), resolved claims identify the source block and output
 * index directly.
 */
export interface ResolvedClaim {
  /** The block that produced the output. */
  block: Hash;
  /** Index into the block's own outputs array. */
  outputIndex: number;
  /** Economic value of the claimed output. */
  value: number;
}

/**
 * Map a surviving output index to its original index in the pre-claim space,
 * given a claim mask that has removed some outputs.
 *
 * The surviving index refers to the nth unclaimed output. This function
 * finds which original index that corresponds to.
 *
 * Returns -1 if the surviving index is out of range.
 */
export function mapSurvivingToOriginal(
  survivingIdx: number,
  claimMask: BitVector,
  length?: number,
): number {
  const len = length ?? claimMask.length;
  let survived = 0;
  for (let i = 0; i < len; i++) {
    if (!claimMask.get(i)) {
      if (survived === survivingIdx) return i;
      survived++;
    }
  }
  return -1;
}

/**
 * Map an original output index to its surviving index after claims are applied.
 *
 * If the original index is claimed (removed), returns -1.
 * Otherwise returns the position of that output among the surviving outputs.
 */
export function mapOriginalToSurviving(
  originalIdx: number,
  claimMask: BitVector,
): number {
  if (claimMask.get(originalIdx)) return -1;
  let survived = 0;
  for (let i = 0; i < originalIdx; i++) {
    if (!claimMask.get(i)) {
      survived++;
    }
  }
  return survived;
}
