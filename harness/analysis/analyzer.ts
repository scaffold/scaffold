#!/usr/bin/env -S deno run --allow-all
/**
 * Harness post-run analyzer. Reads a finished run out of postgres,
 * computes metrics, classifies them against thresholds.yaml, and
 * writes harness/metrics/evaluation.json and evaluation.txt.
 *
 * Usage:
 *   deno run --allow-all harness/analysis/analyzer.ts <run-id> [--pg <url>]
 *                                                              [--config <name>]
 */

import { parse as parseYaml } from '@std/yaml';
import postgres from 'postgres';
import { classify } from './classify.ts';
import { bucketize } from './stats.ts';
import { renderReport } from './format.ts';
import type {
  ClassifiedStat,
  EvaluationReport,
  MetricReport,
  Observation,
  StatName,
  Threshold,
  Thresholds,
} from './types.ts';
import { scopeKey } from './types.ts';

import { compute as computeLatency } from './metrics/latency.ts';
import { compute as computeConnection } from './metrics/connection.ts';
import { compute as computePropagation } from './metrics/propagation.ts';
import { compute as computeReliability } from './metrics/reliability.ts';

const METRIC_FAMILIES = [
  { name: 'latency', compute: computeLatency },
  { name: 'connection', compute: computeConnection },
  { name: 'propagation', compute: computePropagation },
  { name: 'reliability', compute: computeReliability },
];

async function main(): Promise<void> {
  const args = parseCli(Deno.args);
  if (!args.runId) {
    console.error(
      'Usage: deno run --allow-all harness/analysis/analyzer.ts <run-id> [--pg <url>] [--config <name>]',
    );
    Deno.exit(1);
  }

  const thresholdsPath = new URL('./thresholds.yaml', import.meta.url).pathname;
  const thresholdsText = await Deno.readTextFile(thresholdsPath);
  const thresholdsSha256 = await sha256(thresholdsText);
  const thresholds = parseYaml(thresholdsText) as Thresholds;

  const pgUrl = args.pg ?? 'postgres://localhost/scaffold_harness';
  const sql = postgres(pgUrl, { max: 2 });

  let report: EvaluationReport;
  try {
    // Run all metric families in parallel.
    const allObs: Observation[] = (
      await Promise.all(METRIC_FAMILIES.map(async (f) => {
        try {
          return await f.compute(sql, args.runId!);
        } catch (err) {
          console.error(`[analyzer] metric family ${f.name} failed:`, err);
          return [];
        }
      }))
    ).flat();

    const sessions = await sql`
      SELECT
        count(*) FILTER (WHERE NOT is_anchor) AS spawned,
        count(*) FILTER (WHERE NOT is_anchor AND exit_code = 0 AND exit_signal IS NULL) AS clean,
        count(*) FILTER (WHERE NOT is_anchor AND (exit_signal IS NOT NULL OR (exit_code IS NOT NULL AND exit_code <> 0))) AS forced
      FROM app_sessions WHERE run_id = ${args.runId}
    ` as Array<{ spawned: string; clean: string; forced: string }>;
    const row = sessions[0] ?? { spawned: '0', clean: '0', forced: '0' };

    const run = await sql`
      SELECT
        started_at,
        ended_at,
        extract(epoch FROM (COALESCE(ended_at, now()) - started_at))::DOUBLE PRECISION AS duration_s
      FROM harness_runs WHERE run_id = ${args.runId}
    ` as Array<{ started_at: Date; ended_at: Date | null; duration_s: number }>;
    const durationS = Math.round(run[0]?.duration_s ?? 0);

    const metrics = classifyAll(allObs, thresholds);
    const summary = summarize(metrics);

    report = {
      runId: args.runId!,
      ranAt: new Date().toISOString(),
      gitSha: await getGitSha(),
      configName: args.config ?? 'evaluation',
      durationS,
      sessions: {
        spawned: Number(row.spawned),
        cleanExit: Number(row.clean),
        forceExit: Number(row.forced),
      },
      thresholdsSha256,
      summary,
      metrics,
    };
  } finally {
    await sql.end();
  }

  const metricsDir = new URL('../metrics/', import.meta.url).pathname;
  await Deno.mkdir(metricsDir, { recursive: true });
  const baseName = args.config ?? 'evaluation';
  const jsonPath = `${metricsDir}${baseName}.json`;
  const txtPath = `${metricsDir}${baseName}.txt`;
  await Deno.writeTextFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
  const rendered = renderReport(report);
  await Deno.writeTextFile(txtPath, rendered);

  // Mirror the rendered report to stdout.
  Deno.stdout.writeSync(new TextEncoder().encode(rendered));
  console.error(`\nWrote ${jsonPath}`);
  console.error(`Wrote ${txtPath}`);
}

function classifyAll(
  observations: readonly Observation[],
  thresholds: Thresholds,
): MetricReport[] {
  const buckets = bucketize(observations);
  const metricsByScope = new Map<string, MetricReport>();

  for (const [key, { metric, scope, stats }] of buckets) {
    const mt = thresholds.metrics[metric] ?? {};
    const classified: Partial<Record<StatName, ClassifiedStat>> = {};
    for (const statName of Object.keys(mt) as StatName[]) {
      const t: Threshold | undefined = mt[statName];
      if (!t) continue;
      const value = stats[statName];
      if (!Number.isFinite(value)) continue;
      classified[statName] = classify(value, t);
    }
    metricsByScope.set(key, { name: metric, scope, stats, classified });
  }

  // Ensure metrics with configured thresholds but no observations appear
  // in the report as "not classified" / count=0. Useful for spotting
  // regressions where a metric goes missing.
  for (const metricName of Object.keys(thresholds.metrics)) {
    const globalKey = `${metricName}|${scopeKey({ kind: 'global' })}`;
    if (!metricsByScope.has(globalKey)) {
      metricsByScope.set(globalKey, {
        name: metricName,
        scope: { kind: 'global' },
        stats: { mean: NaN, p50: NaN, p90: NaN, p99: NaN, min: NaN, max: NaN, count: 0 },
        classified: {},
      });
    }
  }

  return [...metricsByScope.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return rankScope(a.scope.kind) - rankScope(b.scope.kind);
  });
}

function rankScope(k: string): number {
  return ({ global: 0, app: 1, contract: 2, app_contract: 3 } as Record<string, number>)[k] ?? 99;
}

function summarize(metrics: readonly MetricReport[]): { pass: number; warn: number; fail: number } {
  const s = { pass: 0, warn: 0, fail: 0 };
  for (const m of metrics) {
    for (const c of Object.values(m.classified)) {
      if (!c) continue;
      if (c.classification === 'PASS') s.pass++;
      else if (c.classification === 'WARN') s.warn++;
      else s.fail++;
    }
  }
  return s;
}

async function getGitSha(): Promise<string> {
  try {
    const cmd = new Deno.Command('git', {
      args: ['rev-parse', '--short', 'HEAD'],
      stdout: 'piped',
      stderr: 'null',
    });
    const out = await cmd.output();
    if (!out.success) return 'unknown';
    return new TextDecoder().decode(out.stdout).trim();
  } catch {
    return 'unknown';
  }
}

async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

interface CliArgs {
  runId?: string;
  pg?: string;
  config?: string;
}

function parseCli(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pg') args.pg = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (!args.runId) args.runId = a;
  }
  return args;
}

if (import.meta.main) {
  await main();
}
