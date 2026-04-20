/**
 * Summary statistics over a sample of observations.
 *
 * Percentiles use linear interpolation between samples (nearest-rank
 * gives step-like behaviour that penalizes small sample sizes). All
 * reducers handle empty input by returning NaN for aggregates and 0 for
 * count -- callers can check `count === 0` to decide whether to include
 * the stat in the report.
 */

import type { Observation, Scope, Stats } from './types.ts';
import { scopeKey } from './types.ts';

export function computeStats(values: readonly number[]): Stats {
  const count = values.length;
  if (count === 0) {
    return {
      mean: NaN,
      p50: NaN,
      p90: NaN,
      p99: NaN,
      min: NaN,
      max: NaN,
      count: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    mean: sum / count,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count,
  };
}

/** Linear-interpolation percentile. `p` in [0, 1]. Input MUST be sorted. */
export function percentile(sortedValues: readonly number[], p: number): number {
  const n = sortedValues.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedValues[0];
  if (p <= 0) return sortedValues[0];
  if (p >= 1) return sortedValues[n - 1];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedValues[lo];
  const frac = rank - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

/** Bucket observations by (metric, scope) and compute stats per bucket. */
export function bucketize(
  observations: readonly Observation[],
): Map<string, { metric: string; scope: Scope; stats: Stats }> {
  const groups = new Map<string, { metric: string; scope: Scope; values: number[] }>();
  for (const o of observations) {
    const key = `${o.metric}|${scopeKey(o.scope)}`;
    let g = groups.get(key);
    if (!g) {
      g = { metric: o.metric, scope: o.scope, values: [] };
      groups.set(key, g);
    }
    g.values.push(o.value);
  }
  const out = new Map<string, { metric: string; scope: Scope; stats: Stats }>();
  for (const [key, g] of groups) {
    out.set(key, { metric: g.metric, scope: g.scope, stats: computeStats(g.values) });
  }
  return out;
}
