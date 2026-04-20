import { assert, assertEquals } from '@std/assert';
import { bucketize, computeStats, percentile } from '../harness/analysis/stats.ts';
import { classify } from '../harness/analysis/classify.ts';
import type { Observation, Threshold } from '../harness/analysis/types.ts';

Deno.test('computeStats: empty input returns NaN aggregates and count=0', () => {
  const s = computeStats([]);
  assertEquals(s.count, 0);
  assert(Number.isNaN(s.mean));
  assert(Number.isNaN(s.p50));
});

Deno.test('computeStats: single value -- all aggregates equal', () => {
  const s = computeStats([42]);
  assertEquals(s.count, 1);
  assertEquals(s.mean, 42);
  assertEquals(s.p50, 42);
  assertEquals(s.p99, 42);
  assertEquals(s.min, 42);
  assertEquals(s.max, 42);
});

Deno.test('computeStats: rough sanity on a small sample', () => {
  const s = computeStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assertEquals(s.count, 10);
  assertEquals(s.mean, 5.5);
  assertEquals(s.min, 1);
  assertEquals(s.max, 10);
  assertEquals(s.p50, 5.5);
  // p90 on a uniform 1..10: rank = 0.9 * 9 = 8.1 -> 9*0.9 + 10*0.1 = 9.1
  assertEquals(Math.round(s.p90 * 10) / 10, 9.1);
});

Deno.test('percentile: clamps to min/max for out-of-range p', () => {
  const sorted = [10, 20, 30];
  assertEquals(percentile(sorted, 0), 10);
  assertEquals(percentile(sorted, 1), 30);
  assertEquals(percentile(sorted, 0.5), 20);
});

Deno.test('classify: lower-is-better PASS', () => {
  const t: Threshold = { pass: 100, fail: 500 };
  const r = classify(50, t);
  assertEquals(r.classification, 'PASS');
  assertEquals(r.buffer, 0.5); // 1 - 50/100
});

Deno.test('classify: lower-is-better WARN', () => {
  const t: Threshold = { pass: 100, fail: 500 };
  const r = classify(250, t);
  assertEquals(r.classification, 'WARN');
  assertEquals(r.buffer, -1.5); // 1 - 250/100
});

Deno.test('classify: lower-is-better FAIL', () => {
  const t: Threshold = { pass: 100, fail: 500 };
  const r = classify(1200, t);
  assertEquals(r.classification, 'FAIL');
  assertEquals(r.buffer, -11); // 1 - 1200/100
});

Deno.test('classify: higher-is-better PASS', () => {
  const t: Threshold = { pass: 5, fail: 1 };
  const r = classify(7, t);
  assertEquals(r.classification, 'PASS');
  assertEquals(Math.round(r.buffer! * 100) / 100, 0.4); // 7/5 - 1
});

Deno.test('classify: higher-is-better WARN', () => {
  const t: Threshold = { pass: 5, fail: 1 };
  const r = classify(3, t);
  assertEquals(r.classification, 'WARN');
  assertEquals(Math.round(r.buffer! * 100) / 100, -0.4); // 3/5 - 1
});

Deno.test('classify: higher-is-better FAIL', () => {
  const t: Threshold = { pass: 5, fail: 1 };
  const r = classify(0, t);
  assertEquals(r.classification, 'FAIL');
});

Deno.test('classify: boundary at PASS threshold (lower-is-better)', () => {
  const t: Threshold = { pass: 100, fail: 500 };
  const r = classify(100, t);
  assertEquals(r.classification, 'PASS');
  assertEquals(r.buffer, 0);
});

Deno.test('classify: boundary at FAIL threshold (lower-is-better)', () => {
  const t: Threshold = { pass: 100, fail: 500 };
  const r = classify(500, t);
  assertEquals(r.classification, 'FAIL');
});

Deno.test('classify: pass = 0 yields null buffer but valid classification', () => {
  const t: Threshold = { pass: 0, fail: -100 };
  const pass = classify(0, t);
  assertEquals(pass.classification, 'PASS');
  assertEquals(pass.buffer, null);
  const warn = classify(-50, t);
  assertEquals(warn.classification, 'WARN');
  const fail = classify(-200, t);
  assertEquals(fail.classification, 'FAIL');
});

import { renderReport } from '../harness/analysis/format.ts';
import type { EvaluationReport } from '../harness/analysis/types.ts';

Deno.test('renderReport: produces a report with expected section headings', () => {
  const report: EvaluationReport = {
    runId: 'r-1',
    ranAt: '2026-04-20T00:00:00Z',
    gitSha: 'abc123',
    configName: 'evaluation',
    durationS: 75,
    sessions: { spawned: 5, cleanExit: 4, forceExit: 1 },
    thresholdsSha256: 'hash',
    summary: { pass: 2, warn: 1, fail: 1 },
    metrics: [
      {
        name: 'req_reply_latency_ms',
        scope: { kind: 'global' },
        stats: { mean: 150, p50: 130, p90: 280, p99: 350, min: 10, max: 1200, count: 42 },
        classified: {
          mean: { value: 150, classification: 'WARN', buffer: -0.5 },
          p99: { value: 350, classification: 'WARN', buffer: -0.75 },
        },
      },
      {
        name: 'clean_exit_pct',
        scope: { kind: 'global' },
        stats: { mean: 0.8, p50: 1, p90: 1, p99: 1, min: 0, max: 1, count: 5 },
        classified: {
          mean: { value: 0.8, classification: 'WARN', buffer: -0.15 },
        },
      },
    ],
  };
  const out = renderReport(report);
  assert(out.includes('Latency + fetch reliability'));
  assert(out.includes('Reliability + balance'));
  assert(out.includes('[WARN]'));
  assert(out.includes('req_reply_latency_ms'));
  assert(out.includes('Summary: 2 PASS'));
});

Deno.test('bucketize: splits observations by metric + scope', () => {
  const obs: Observation[] = [
    { metric: 'lat', scope: { kind: 'global' }, value: 1 },
    { metric: 'lat', scope: { kind: 'global' }, value: 3 },
    { metric: 'lat', scope: { kind: 'app', app: 'social' }, value: 5 },
    { metric: 'other', scope: { kind: 'global' }, value: 99 },
  ];
  const buckets = bucketize(obs);
  assertEquals(buckets.size, 3);
  const globalLat = [...buckets.values()].find((b) =>
    b.metric === 'lat' && b.scope.kind === 'global'
  )!;
  assertEquals(globalLat.stats.count, 2);
  assertEquals(globalLat.stats.mean, 2);
});
