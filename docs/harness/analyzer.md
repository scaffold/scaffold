# Harness Analyzer

The analyzer is a post-run step that reads a finished run out of
postgres, computes metrics, classifies them against thresholds, and
writes `harness/metrics/evaluation.json` + `evaluation.txt`. The user
reviews the diff and commits.

## Design philosophy

- **Metric files emit observations, not aggregates.** Each metric
  family in `harness/analysis/metrics/*.ts` exports an async
  `compute(sql, runId) -> Observation[]`. An observation is a
  `{ metric, scope, value }` triple. Computation of mean / p50 / p90 /
  p99 is centralized in `stats.ts`.

- **Direction is inferred from threshold ordering.** In
  `thresholds.yaml`, if `pass < fail` the metric is lower-is-better;
  if `pass > fail`, higher-is-better. No `direction:` field.

- **Classification uses three bands.** `pass` and `fail` are the
  boundaries; anything between is WARN. `buffer` is a signed ratio
  relative to `pass` -- positive means past the PASS threshold,
  negative means on the WARN or FAIL side.

- **Single committed file per config.** `evaluation.json` and
  `evaluation.txt` are overwritten each run. History lives in
  `git log -p harness/metrics/`.

## Observations -> Stats -> Classification -> Report

```
[compute() in metrics/*.ts]                returns Observation[]
                |
                v
[bucketize() in stats.ts]                  groups by (metric, scope),
                |                          computes Stats per bucket
                v
[classify() in classify.ts]                for each Stat name listed in
                |                          thresholds.yaml, compute
                |                          ClassifiedStat
                v
[format.ts + analyzer.ts]                  write evaluation.{json,txt}
```

### Observation

```ts
interface Observation {
  metric: string;              // 'req_reply_latency_ms'
  scope: Scope;                // global | app=... | contract=... | app_contract=...
  value: number;
}
```

### Stats

```ts
interface Stats {
  mean: number; p50: number; p90: number; p99: number;
  min: number; max: number; count: number;
}
```

Percentiles use linear interpolation between sorted samples.

### ClassifiedStat

```ts
interface ClassifiedStat {
  value: number;
  classification: 'PASS' | 'WARN' | 'FAIL';
  buffer: number | null;   // fraction vs pass threshold; null iff pass = 0
}
```

### Buffer formula

| Direction          | Formula              | Example (pass=100)         |
|--------------------|----------------------|----------------------------|
| Lower is better    | `1 - value / pass`   | value=80 -> buffer=+0.20   |
|                    |                      | value=120 -> buffer=-0.20  |
| Higher is better   | `value / pass - 1`   | value=6, pass=5 -> +0.20   |
|                    |                      | value=4, pass=5 -> -0.20   |

When `pass = 0`, the ratio is undefined and `buffer = null`.
Classification is still valid. Prefer non-zero thresholds so the
buffer reads meaningfully; a metric naturally centered at zero
(e.g., a delta) can use small nominal thresholds rather than zero.

## thresholds.yaml

```yaml
metrics:
  req_reply_latency_ms:
    mean: { pass: 150, fail: 800 }    # pass < fail -> lower is better
    p99:  { pass: 500, fail: 3000 }

  clean_exit_pct:
    mean: { pass: 0.95, fail: 0.5 }   # pass > fail -> higher is better
```

Each `(metric, stat)` pair gets its own `{ pass, fail }`. Missing
pairs are computed (appear in `stats`) but not classified.

The analyzer records `thresholdsSha256` in the output so diffs caused
by threshold edits are easy to distinguish from diffs caused by system
behavior drift.

## Running

```sh
deno run --allow-all harness/analysis/analyzer.ts <run-id> \
  [--pg postgres://host/db] [--config eval]
```

Writes to `harness/metrics/<config>.json` and `<config>.txt` (default
`evaluation`). Prints the text report to stdout.

## Committing

The usual loop:

```sh
deno run --allow-all harness/analysis/analyzer.ts r-1776000000000
git diff harness/metrics/evaluation.txt          # human-readable diff
git add harness/metrics/evaluation.{json,txt}
git commit -m "metrics: <one-line summary of why it changed>"
```

Commit messages should say what caused the change -- a threshold edit,
a behavior change, a protocol change -- not just "update metrics."

## Adding a new metric

1. Decide which family it belongs to (latency, connection, propagation,
   reliability) or create a new one.
2. Emit the underlying raw events from your behavior / from Scaffold.
3. Add a query in `harness/analysis/metrics/<family>.ts` that returns
   `Observation[]` at whatever scopes make sense.
4. Add a threshold entry under `harness/analysis/thresholds.yaml`.
5. Run the evaluation config end-to-end and commit the updated files.

If a new metric has no threshold yet, observations still appear in
`stats` but `classified` stays empty -- it shows up in the report as
"(not classified)". Use this as a staging area before tuning
thresholds.

## Known limitations (v1)

- `req_reply_latency_ms` requires behaviors to emit `send_intent` +
  `reply` with matching `requestId`. Until behaviors are wired up, the
  metric reports zero observations.
- `balance_delta_per_session` requires behaviors to emit
  `balance_change` events. Same status.
- `block_propagation_ms` needs `>= 5` concurrent sessions at a block's
  first-seen wall-clock to be meaningful. Blocks seen earlier than
  that are skipped.
- The analyzer assumes the observer has fully drained before it runs.
  If the observer is lagging, early observations may be missing.
  Wait until `ingest_offsets` has converged with the files on disk.
