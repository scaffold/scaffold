/**
 * Classify a stat value against a pass/fail threshold pair. Direction
 * is inferred from the ordering of `pass` and `fail`:
 *
 *   pass <  fail  ->  lower is better  (e.g., latency)
 *   pass >  fail  ->  higher is better (e.g., clean_exit_pct)
 *   pass == fail  ->  exact threshold; buffer undefined
 *
 * `buffer` is a signed ratio relative to `pass`:
 *   lower_is_better:  1 - value / pass
 *   higher_is_better: value / pass - 1
 *
 * Positive buffer means the stat is strictly beyond the PASS threshold
 * (passing by some margin). Negative buffer means the stat is on the
 * WARN or FAIL side of the PASS threshold.
 *
 * When `pass` is zero the ratio is undefined; we emit null rather than
 * infinity. Classification is still valid (WARN/FAIL bands are
 * well-defined on either side of zero).
 */

import type { Classification, ClassifiedStat, Threshold } from './types.ts';

export function classify(value: number, t: Threshold): ClassifiedStat {
  const lowerIsBetter = t.pass < t.fail;
  const higherIsBetter = t.pass > t.fail;

  let classification: Classification;
  if (lowerIsBetter) {
    if (value <= t.pass) classification = 'PASS';
    else if (value >= t.fail) classification = 'FAIL';
    else classification = 'WARN';
  } else if (higherIsBetter) {
    if (value >= t.pass) classification = 'PASS';
    else if (value <= t.fail) classification = 'FAIL';
    else classification = 'WARN';
  } else {
    // pass == fail: an exact threshold. Treat value on the "desired"
    // side of pass as PASS; the other side is FAIL (no WARN band).
    classification = value === t.pass ? 'PASS' : 'FAIL';
  }

  const buffer = computeBuffer(value, t, lowerIsBetter, higherIsBetter);

  return { value, classification, buffer };
}

function computeBuffer(
  value: number,
  t: Threshold,
  lowerIsBetter: boolean,
  higherIsBetter: boolean,
): number | null {
  if (t.pass === 0) return null;
  if (lowerIsBetter) return 1 - value / t.pass;
  if (higherIsBetter) return value / t.pass - 1;
  return null;
}
