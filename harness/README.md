# Scaffold Network Test Harness

Large-scale real-process simulation for the Scaffold protocol. Targets
100 concurrent Deno processes on a single host, each running a simulated
"application" (social media scroller, money sender, aggregator,
validator, etc.) on top of a real `Scaffold` instance with latency-
wrapped Unix-socket transport.

## Components

| Piece                        | Role                                                      |
|------------------------------|-----------------------------------------------------------|
| `coordinator.ts`             | Loads YAML, builds keypool + genesis, spawns app processes |
| `observer.ts`                | Tails JSONL, batched-inserts to postgres                  |
| `applications/App.ts`        | Runtime each behavior imports: Scaffold + stdout JSONL    |
| `applications/behaviors/`    | Per-application behavior functions                        |
| `transports/LatencyTransport`| Wraps UnixSocketTransport with haversine + jitter         |
| `db/schema.sql`              | Postgres schema for events + sessions + offsets           |
| `db/queries/`                | Canned SQL for common introspection                       |

## Running a smoke test

Prereqs: Deno; postgres if you want to ingest events.

```sh
# 1. (optional) set up postgres
createdb scaffold_harness
deno run --allow-all harness/db/migrate.ts postgres://localhost/scaffold_harness

# 2. run the coordinator
deno run --allow-all harness/coordinator.ts harness/configs/smoke.yaml

# 3. in another terminal: run the observer against the same run
deno run --allow-all harness/observer.ts ./runs r-<timestamp> \
  postgres://localhost/scaffold_harness
```

`r-<timestamp>` is printed to the coordinator's stdout as `run.started`.

## Anatomy of a run directory

```
runs/
  <run-id>/
    coordinator.jsonl          # coordinator's own event stream
    genesis.hex                # serialized genesis packet (deterministic)
    peers.json                 # live peer manifest (atomic writes)
    events/
      <session-id>.jsonl       # one file per app session (scaffold + app events)
    stderr/
      <session-id>.log         # per-session stderr capture
```

## Postgres queries

After a run has ingested:

```sh
# Find packets sent without a matching recv (silent-leave evidence).
psql scaffold_harness -v run_id=r-1234 -f harness/db/queries/packets_without_recv.sql

# Trace propagation of a specific block across the fleet.
psql scaffold_harness -v run_id=r-1234 -v block_hash=deadbeef.. \
  -f harness/db/queries/block_propagation.sql

# Per-app throughput over time.
psql scaffold_harness -v run_id=r-1234 -f harness/db/queries/per_app_throughput.sql

# Request/reply latency (for behaviors that tag requests).
psql scaffold_harness -v run_id=r-1234 -f harness/db/queries/req_reply_latency.sql
```

## Configuration

See `configs/smoke.yaml` and `configs/stress.yaml`. Keys of note:

- `run.force_close_rate` — fraction of non-anchor sessions that exit via
  SIGKILL (abrupt) rather than SIGTERM + `scaffold.close()`. SIGKILL'd
  sessions abandon their latency-transport send queue mid-flight, which
  produces the "send without recv" postgres evidence.
- `bootstrap.anchor_count` — number of long-lived anchor processes to
  spawn at startup. New apps always include all anchors + random recent
  peers in their bootstrap set.
- `geography.latency.speed_factor` — fraction of c (speed of light).
  Real fiber is ~0.6-0.7; 0.5 gives recognizable trans-continental RTTs.
- `applications[].is_anchor` — when true, the app is treated as a long-
  lived fleet participant (no session timer, no exit).

## Scope (v1)

- Single host, up to ~100 processes (1 per session).
- Unix socket transport with authenticated handshake via
  `UnixSocketTransport` (session socket path is the shared secret).
- Random-uniform geography + haversine one-way latency + uniform jitter.
- No packet loss, no partitions, no bandwidth/compute caps (Scaffold is
  expected to self-limit; if it doesn't, file a TODO.md entry).
- Cold-start per session: no persistent per-user storage.
- Behaviors are v1 stubs emitting intent events; wiring them to real
  `scaffold.put()` / `scaffold.fetch()` against application contracts
  is future work.

## Hacking

- Add a new behavior: drop a file in `applications/behaviors/`, import
  `runApplication`, call it with an async function receiving
  `AppContext`. Register it in a YAML config.
- Add a new metric query: drop a SQL file in `db/queries/`. Query events
  via JSONB `data->>'...'` or `data @> '{...}'::jsonb`.
- Custom geography: implement the `Geography` interface in
  `harness/geography.ts`, extend `config.ts` to select it.
