/**
 * Shared types for the harness metrics analyzer.
 *
 * Philosophy:
 *  - Each metric family in metrics/*.ts yields Observations (labelled
 *    numbers).
 *  - Shared code (stats.ts) converts Observation[] into Stats per
 *    (metric, scope).
 *  - Shared code (classify.ts) compares each configured (metric, stat)
 *    pair to thresholds.yaml and produces a ClassifiedStat with a
 *    relative buffer.
 *  - The analyzer (analyzer.ts) orchestrates and emits evaluation.json
 *    + evaluation.txt.
 */

export type Classification = 'PASS' | 'WARN' | 'FAIL';

export type Scope =
  | { kind: 'global' }
  | { kind: 'app'; app: string }
  | { kind: 'contract'; contract: string }
  | { kind: 'app_contract'; app: string; contract: string };

export interface Observation {
  metric: string;
  scope: Scope;
  value: number;
}

export interface Stats {
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

export type StatName = keyof Stats;

export interface Threshold {
  /** Value at or beyond which the metric is PASS. */
  pass: number;
  /** Value at or beyond which the metric is FAIL. */
  fail: number;
}

export interface ClassifiedStat {
  value: number;
  classification: Classification;
  /**
   * Relative margin vs pass threshold.
   *   lower_is_better: 1 - value / pass
   *   higher_is_better: value / pass - 1
   * Positive => passing; negative => WARN or FAIL. null when pass = 0
   * (undefined ratio); classification is still valid.
   */
  buffer: number | null;
}

export interface MetricReport {
  name: string;
  scope: Scope;
  stats: Stats;
  /** Only stats with thresholds configured appear here. */
  classified: Partial<Record<StatName, ClassifiedStat>>;
}

export interface RunSummary {
  pass: number;
  warn: number;
  fail: number;
}

export interface EvaluationReport {
  runId: string;
  ranAt: string; // ISO
  gitSha: string;
  configName: string;
  durationS: number;
  sessions: {
    spawned: number;
    cleanExit: number;
    forceExit: number;
  };
  thresholdsSha256: string;
  summary: RunSummary;
  metrics: MetricReport[];
}

/** thresholds.yaml parsed shape. */
export interface Thresholds {
  metrics: Record<string, Partial<Record<StatName, Threshold>>>;
}

export function scopeToString(s: Scope): string {
  switch (s.kind) {
    case 'global':
      return 'global';
    case 'app':
      return `app=${s.app}`;
    case 'contract':
      return `contract=${shortHash(s.contract)}`;
    case 'app_contract':
      return `app=${s.app},contract=${shortHash(s.contract)}`;
  }
}

function shortHash(h: string): string {
  return h.length > 12 ? `${h.slice(0, 10)}..` : h;
}

export function scopeKey(s: Scope): string {
  switch (s.kind) {
    case 'global':
      return '__global__';
    case 'app':
      return `a:${s.app}`;
    case 'contract':
      return `c:${s.contract}`;
    case 'app_contract':
      return `ac:${s.app}:${s.contract}`;
  }
}
