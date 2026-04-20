/**
 * Stdout + text-file rendering of the evaluation report. Grouped by
 * metric family heuristically (by name prefix), with PASS/WARN/FAIL
 * markers and a `buffer` percentage.
 */

import {
  type ClassifiedStat,
  type EvaluationReport,
  type MetricReport,
  scopeToString,
  type StatName,
} from './types.ts';

const METRIC_GROUPS: Array<{ title: string; metrics: string[] }> = [
  {
    title: 'Latency + fetch reliability',
    metrics: ['req_reply_latency_ms', 'fetch_unanswered_pct'],
  },
  {
    title: 'Connection',
    metrics: ['peers_per_session', 'time_to_first_peer_ms', 'time_to_first_block_ms'],
  },
  {
    title: 'Propagation + throughput',
    metrics: [
      'block_propagation_ms',
      'blocks_per_sec_per_session',
      'contracts_per_sec_per_session',
    ],
  },
  {
    title: 'Reliability + balance',
    metrics: ['clean_exit_pct', 'errors_per_session', 'balance_delta_per_session'],
  },
];

export function renderReport(report: EvaluationReport): string {
  const lines: string[] = [];
  lines.push(
    `Evaluation metrics for run ${report.runId}  (git ${report.gitSha}, ${
      formatDuration(report.durationS)
    })`,
  );
  lines.push(`Config:   ${report.configName}`);
  lines.push(`Ran at:   ${report.ranAt}`);
  lines.push(
    `Sessions: ${report.sessions.spawned} spawned, ${report.sessions.cleanExit} clean, ${report.sessions.forceExit} force`,
  );
  lines.push('');

  // Bucket MetricReports by the first group that contains the metric name.
  const buckets = new Map<string, MetricReport[]>();
  for (const g of METRIC_GROUPS) buckets.set(g.title, []);
  const uncategorized: MetricReport[] = [];
  for (const m of report.metrics) {
    const group = METRIC_GROUPS.find((g) => g.metrics.includes(m.name));
    if (group) buckets.get(group.title)!.push(m);
    else uncategorized.push(m);
  }

  for (const g of METRIC_GROUPS) {
    const entries = buckets.get(g.title) ?? [];
    if (entries.length === 0) continue;
    lines.push(g.title);
    lines.push('-'.repeat(g.title.length));
    lines.push(...renderGroup(entries));
    lines.push('');
  }

  if (uncategorized.length > 0) {
    lines.push('Other');
    lines.push('-----');
    lines.push(...renderGroup(uncategorized));
    lines.push('');
  }

  lines.push(
    `Summary: ${report.summary.pass} PASS  |  ${report.summary.warn} WARN  |  ${report.summary.fail} FAIL`,
  );

  return lines.join('\n') + '\n';
}

function renderGroup(reports: MetricReport[]): string[] {
  // Stable ordering: metric name, then global-first within scopes.
  const sorted = [...reports].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return rankScope(a.scope.kind) - rankScope(b.scope.kind);
  });

  const out: string[] = [];
  for (const r of sorted) {
    const scopeStr = scopeToString(r.scope);
    // Print one row per classified stat; also show count once per metric+scope.
    const classifiedEntries = Object.entries(r.classified) as Array<
      [StatName, ClassifiedStat]
    >;
    if (classifiedEntries.length === 0) {
      out.push(
        `  ${pad(r.name, 34)}${pad(scopeStr, 28)}${pad(`n=${r.stats.count}`, 12)}(not classified)`,
      );
      continue;
    }
    for (const [stat, c] of classifiedEntries) {
      const valueStr = formatValue(r.name, c.value);
      const bufferStr = c.buffer === null ? '' : ` by ${formatBuffer(c.buffer)}`;
      out.push(
        `  ${pad(r.name, 34)}${pad(scopeStr, 28)}${pad(stat, 6)}=${
          pad(valueStr, 10)
        }[${c.classification}]${bufferStr}  (n=${r.stats.count})`,
      );
    }
  }
  return out;
}

function rankScope(k: string): number {
  switch (k) {
    case 'global':
      return 0;
    case 'app':
      return 1;
    case 'contract':
      return 2;
    case 'app_contract':
      return 3;
  }
  return 99;
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s + ' ';
  return s + ' '.repeat(w - s.length);
}

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

function formatValue(metric: string, v: number): string {
  if (metric.endsWith('_ms')) return `${round(v, 0)}ms`;
  if (metric.endsWith('_pct')) return `${round(v * 100, 1)}%`;
  if (metric.endsWith('_per_session')) return round(v, 2).toString();
  if (metric.endsWith('_per_sec_per_session')) return `${round(v, 2)}/s`;
  return round(v, 2).toString();
}

function formatBuffer(b: number): string {
  const pct = Math.round(b * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function round(v: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}
