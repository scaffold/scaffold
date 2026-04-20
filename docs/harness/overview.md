# Scaffold Harness Overview

The harness is a real-process simulation for exercising the Scaffold
protocol at scale. It targets 100 concurrent Deno processes on a single
host, each running a simulated "application" on top of a real
`Scaffold` instance, with latency-wrapped Unix-socket transport.

The harness is **not** part of the protocol. It lives under
`harness/`, outside `src/`, and its tests live under `tests/harness*`.
Nothing in `src/` should import from `harness/`.

## Topology

```
                                 +------------------+
 harness/configs/eval.yaml ----> |   coordinator    |
                                 |  (harness/       |
                                 |   coordinator.ts)|
                                 +--------+---------+
                                          |
                    +---------------------+---------------------+
                    |                     |                     |
             spawns app 1          spawns app 2          spawns app N
                    |                     |                     |
                    v                     v                     v
         +----------+---------+  +--------+--------+  +--------+--------+
         |    social_media    |  |    anchor       |  |    money_send   |
         |  runApplication()  |  | runApplication()|  | runApplication()|
         |  Scaffold instance |  | Scaffold inst.  |  | Scaffold inst.  |
         |  LatencyTransport  |  | LatencyTransport|  | LatencyTransport|
         +----+---------------+  +--+-----+--------+  +--------+--------+
              |                     ^     |                   |
              |    unix sockets     |     |                   |
              +---------------------+-----+-------------------+
                                    |
               stdout JSONL per session -> runs/<id>/events/<session>.jsonl
                                    |
                                    v
                              +-----+-----+       +------------------+
                              |  observer | ----> |   postgres       |
                              +-----------+       +--------+---------+
                                                           |
                                                           v
                              +------------------+   +-----+-----+
                              |   analyzer       |<--+ sql query |
                              |  (harness/       |   +-----------+
                              |   analysis/      |
                              |   analyzer.ts)   |
                              +--------+---------+
                                       |
                                       v
                      harness/metrics/evaluation.{json,txt}
                      (committed; diffed across runs via git log)
```

## Lifecycle of a run

1. **Coordinator startup.** Loads YAML, builds a keypool of end-user
   keypairs with randomized balances, constructs a deterministic
   genesis block from those balances, writes the run directory
   skeleton, and spawns any `is_anchor: true` applications first so
   that subsequent spawns have a backbone to bootstrap to.
2. **Poisson-scheduled app spawns.** Each non-anchor application has a
   `spawn_rate_per_s`. For `run.duration_s`, the coordinator samples
   independent exponential interarrivals for each app and spawns
   sessions as they come due.
3. **Per-session app lifecycle.** Each spawned app reads env vars
   (socket path, bootstrap peers, coord, genesis path, keypair, etc.),
   constructs a `Scaffold`, subscribes to `eventLog.onAppend`, and
   runs its behavior. All events go to stdout as JSONL and are
   redirected by the coordinator into `runs/<id>/events/<session>.jsonl`.
4. **Termination.** At session end, `run.force_close_rate` fraction get
   SIGKILL (abrupt, abandoning in-flight latency queue entries). The
   rest get SIGTERM, which the behavior converts into a clean
   `scaffold.close()`.
5. **Observer ingest.** Runs concurrently with the coordinator, tailing
   each events file and batch-inserting into postgres.
6. **Analyzer.** After the run finishes, `harness/analysis/analyzer.ts`
   reads postgres, computes metrics with PASS/WARN/FAIL classifications,
   writes `harness/metrics/evaluation.{json,txt}`, prints the report.

## Run directory anatomy

```
runs/
  <run-id>/
    coordinator.jsonl        # coordinator's own event stream
    genesis.hex              # serialized genesis packet, deterministic
    peers.json               # live peer manifest (atomic rename writes)
    events/
      <session-id>.jsonl     # per-app stdout (scaffold + app events)
    stderr/
      <session-id>.log       # per-app stderr capture
```

## Typical command sequence

```sh
# 1. (once per machine) set up postgres.
createdb scaffold_harness
deno run --allow-all harness/db/migrate.ts postgres://localhost/scaffold_harness

# 2. run the coordinator.
deno run --allow-all harness/coordinator.ts harness/configs/evaluation.yaml

# 3. in another shell, run the observer against the same run.
deno run --allow-all harness/observer.ts ./runs r-<ts> \
  postgres://localhost/scaffold_harness

# 4. after the run finishes, analyze.
deno run --allow-all harness/analysis/analyzer.ts r-<ts>

# 5. inspect and commit the updated metrics.
git diff harness/metrics/evaluation.txt
git add harness/metrics/evaluation.{json,txt}
git commit
```

## Scope (v1)

Implemented:

- Single-host, up to ~100 concurrent processes.
- Authenticated Unix-socket transport (session socket path is the secret).
- Random-uniform geography + haversine one-way latency + jitter.
- Anchor-based bootstrap with peer manifest exposed to apps for peer
  migration logic.
- Postgres observer with per-file resume offsets.
- PASS/WARN/FAIL classification with `buffer` ratio vs PASS threshold.

Explicitly deferred (see [TODO.md](../../TODO.md)):

- Packet loss, partitions, byzantine behaviors.
- Bandwidth / compute caps (Scaffold is expected to self-limit).
- Persistent per-user state (StorageProvider mock).
- Peer-aware latency on accepted inbound connections.

## Further reading

- [configs.md](./configs.md) -- YAML schema and tuning knobs
- [applications.md](./applications.md) -- writing behaviors
- [transport.md](./transport.md) -- LatencyTransport and PeerDirectory
- [observer.md](./observer.md) -- postgres schema and ingest details
- [analyzer.md](./analyzer.md) -- metrics, thresholds, classification
