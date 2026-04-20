# Scaffold Network Test Harness

Large-scale real-process simulation for the Scaffold protocol. Targets
100 concurrent Deno processes on a single host, each running a simulated
"application" on top of a real `Scaffold` instance with latency-
wrapped Unix-socket transport.

**Full docs live in [`docs/harness/`](../docs/harness/overview.md).**
This file is a quick-start; the subtree has details on configs,
applications, transport, observer, and analyzer.

## Quick start

```sh
# 1. set up postgres once
createdb scaffold_harness
deno run --allow-all harness/db/migrate.ts postgres://localhost/scaffold_harness

# 2. run the evaluation config (10 minutes, 300 users, ~80 concurrent)
deno run --allow-all harness/coordinator.ts harness/configs/evaluation.yaml
# prints `run.started` with `runId: r-<ts>`

# 3. in another terminal, ingest events as they come
deno run --allow-all harness/observer.ts ./runs r-<ts> \
  postgres://localhost/scaffold_harness

# 4. when the run ends, compute metrics
deno run --allow-all harness/analysis/analyzer.ts r-<ts>
# writes harness/metrics/evaluation.{json,txt}

# 5. review and commit
git diff harness/metrics/evaluation.txt
git add harness/metrics/evaluation.{json,txt}
git commit
```

## Layout

```
harness/
  coordinator.ts              # spawns apps; see docs/harness/overview.md
  observer.ts                 # postgres ingest; see docs/harness/observer.md
  analysis/analyzer.ts        # metrics; see docs/harness/analyzer.md
  analysis/thresholds.yaml    # PASS/FAIL per metric stat
  applications/App.ts         # shared app runtime
  applications/behaviors/     # one file per app (anchor, social_media, etc.)
  transports/LatencyTransport # simulated latency wrapper
  transports/PeerDirectory    # live peers.json view
  configs/                    # smoke.yaml, stress.yaml, evaluation.yaml
  db/                         # schema.sql + canned queries
  metrics/                    # committed evaluation.{json,txt}

docs/harness/                 # the authoritative docs
runs/<run-id>/                # per-run artifacts (gitignored)
```

## When to read what

| I want to...                              | Go to                               |
|-------------------------------------------|-------------------------------------|
| Understand the lifecycle of a run         | [overview.md](../docs/harness/overview.md) |
| Tune a config                             | [configs.md](../docs/harness/configs.md)   |
| Write a new application behavior          | [applications.md](../docs/harness/applications.md) |
| Understand the LatencyTransport           | [transport.md](../docs/harness/transport.md) |
| Query events in postgres                  | [observer.md](../docs/harness/observer.md) |
| Understand or add a metric                | [analyzer.md](../docs/harness/analyzer.md) |
