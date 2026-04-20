# Harness Configuration

Every harness run is driven by a YAML config validated by the zod
schema in `harness/config.ts`. Three configs ship with the repo:

| File                         | Duration | Users | Concurrency | Use                       |
|------------------------------|----------|-------|-------------|---------------------------|
| `configs/smoke.yaml`         | 20s      | 50    | ~10-15      | CI-grade smoke tests      |
| `configs/stress.yaml`        | 10m      | 500   | ~100        | Stress + tail observation |
| `configs/evaluation.yaml`    | 10m      | 300   | ~80         | Canonical PASS/WARN/FAIL  |

The **evaluation** config is the one whose metrics are committed to
`harness/metrics/evaluation.{json,txt}`. Changes there move the
baseline; change with intent.

## Schema walkthrough

```yaml
run:
  id: auto                 # "auto" -> r-<unix_ms>; or an explicit string
  duration_s: 600          # total seconds to schedule spawns
  force_close_rate: 0.2    # fraction of non-anchor exits that SIGKILL
  base_seed: 7             # root RNG seed; affects coords, balances,
                           # spawn intervals, etc.

users:
  count: 300               # size of the end-user keypool
  seed_prefix: eval        # private keys derived from `${prefix}:${i}`
  balance_distribution:
    zero_fraction: 0.25    # fraction of users with balance = 0 (new users)
    power_law:             # remaining users sample a power-law amount
      alpha: 1.5           # tail exponent; higher = flatter
      min: 100
      max: 1000000

geography:
  kind: random_uniform     # only kind implemented in v1
  latency:
    speed_factor: 0.5      # fraction of c (speed of light); ~0.6 in real fiber
    jitter_min_ms: 5       # uniform jitter floor per send
    jitter_max_ms: 30      # uniform jitter ceiling per send
    min_ms: 5              # absolute floor after haversine + jitter
    fleet_fallback_ms: 60  # used when remote coord unknown (accepted conns)

bootstrap:
  anchor_count: 3          # N anchor processes spawned before others
  peers_per_new_app: 5     # all anchors + random recent peers, up to this total

applications:
  - name: anchor
    entrypoint: harness/applications/behaviors/anchor.ts
    is_anchor: true        # long-lived; no spawn rate, no session timer
  - name: social_media
    entrypoint: harness/applications/behaviors/social_media.ts
    spawn_rate_per_s: 0.33 # Poisson lambda
    session_duration_s:    # Gaussian duration (seconds)
      mean: 180
      stddev: 60
    params:                # opaque JSON forwarded to the behavior
      scrollIntervalMs: { mean: 2000, stddev: 400 }
      feedSize: 90
      peerMigrationRate: 0.05

observer:
  postgres_url: postgres://localhost/scaffold_harness
  batch_size: 500          # rows per INSERT
  flush_interval_ms: 250   # max time a batch sits before flushing
  lag_threshold_bytes: 1000000000

paths:
  runs_root: ./runs        # per-run directories land here
  socket_root: /tmp        # unix socket files (and auth sockets) land here
```

## Spawn rate math

Given `spawn_rate_per_s = 0.33` for an app:

- Interarrival time is `Exponential(0.33)` seconds (mean 3s).
- Expected sessions over `run.duration_s` = `0.33 * 600 = ~198`.
- Steady-state concurrency = `spawn_rate_per_s * session_duration_s.mean`.
  For `social_media` above: `0.33 * 180 = ~60` concurrent sessions.

To hit a target concurrency `C` with session duration `D`:

```
spawn_rate_per_s = C / D
```

## Geography tuning

`speed_factor` controls how aggressively the haversine distance maps to
one-way latency. Real fiber runs at ~0.6-0.7 of c; use 0.5 for a
slightly conservative default that produces recognizable
trans-continental RTTs (~140-160ms NY-SF).

`jitter_min_ms` + `jitter_max_ms` add a uniform per-send jitter. To
simulate a highly stable link, set both to a small value. To simulate
congestion, raise `jitter_max_ms`.

`fleet_fallback_ms` is used when the local `LatencyTransport` doesn't
know the remote's coordinates (inbound accepted connections; see
[transport.md](./transport.md)). Set it near your fleet mean.

## Force-close tuning

`run.force_close_rate` is the fraction of non-anchor sessions that
terminate via SIGKILL rather than SIGTERM. SIGKILL'd sessions abandon
their `LatencyTransport` send queue mid-flight, producing the "send
without matching recv" evidence the
`packets_without_recv.sql` query looks for.

A value of 0 means every session exits gracefully (useful to isolate
latency/throughput metrics from churn). A value of 1 means every
session is killed (useful for churn-tolerance testing).

## Adding a new application entry

1. Write a behavior file under `harness/applications/behaviors/` using
   `runApplication()` (see [applications.md](./applications.md)).
2. Add an entry to the `applications:` list in your YAML with:
   - `name` (unique)
   - `entrypoint` (path relative to repo root)
   - `spawn_rate_per_s` and `session_duration_s` (or `is_anchor: true`)
   - `params` (will be JSON-stringified and passed as env `PARAMS_JSON`)

The coordinator forwards `params` verbatim to the behavior; the behavior
reads them via `ctx.params` and casts to its own interface type.
