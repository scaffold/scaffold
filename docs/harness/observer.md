# Harness Observer

The observer ingests the coordinator's + applications' JSONL stdout
into postgres, where the analyzer queries it to compute metrics. It
runs concurrently with the coordinator.

## Data flow

```
   runs/<id>/events/<session>.jsonl ----+
   runs/<id>/coordinator.jsonl ---------+--> [observer.ts] --> postgres
                                                                |
                                                                v
                                                       [analyzer.ts]
```

The observer polls every 100ms:

1. Scans `runs/<id>/events/` for new `.jsonl` files.
2. For each known file, tails from its last offset (persisted in
   `ingest_offsets`) and parses each newline-terminated JSON line.
3. Batches parsed events into ~500-row INSERTs against `events`.
4. Reacts to coordinator events like `session.spawned` /
   `session.exited` to populate `app_sessions` lifecycle columns.

## Schema

Defined in `harness/db/schema.sql`. The primary tables:

### `harness_runs`

Logged (normal) table. One row per `deno run coordinator.ts ...` invocation.

| Column       | Type        |
|--------------|-------------|
| run_id       | TEXT PK     |
| started_at   | TIMESTAMPTZ |
| ended_at     | TIMESTAMPTZ |
| config_yaml  | TEXT        |
| git_sha      | TEXT        |

### `app_sessions`

Logged. One row per spawned application process. The observer
upserts on `session.spawned` and updates `ended_at`/`exit_code` on
`session.exited`.

| Column         | Type             |
|----------------|------------------|
| run_id         | TEXT             |
| session_id     | TEXT             |
| application    | TEXT             |
| user_pubkey    | TEXT             |
| address        | TEXT             |
| lat, lon       | DOUBLE PRECISION |
| is_anchor      | BOOLEAN          |
| started_at     | TIMESTAMPTZ      |
| ended_at       | TIMESTAMPTZ      |
| exit_code      | INTEGER          |
| exit_signal    | TEXT             |

PK: `(run_id, session_id)`.

### `events`

**Unlogged** (no crash recovery; 2-3x insert speedup). One row per
stdout line, both scaffold-originated (`kind='event'`) and
app-originated (`kind='app'`).

| Column     | Type             |
|------------|------------------|
| run_id     | TEXT             |
| session_id | TEXT             |
| kind       | TEXT             |  `event`, `app`, or `stderr`
| seq        | BIGINT           |  per-session, per-kind monotonic
| wall_ts    | BIGINT           |  Date.now() at emission
| ts         | DOUBLE PRECISION |  performance.now() (scaffold events only)
| system     | TEXT             |  e.g. `network`, `coordinator`, `app`
| event      | TEXT             |
| level      | TEXT             |  `debug`, `info`, `warn`, `error`
| data       | JSONB            |

PK: `(run_id, session_id, kind, seq)`.

Indexes:

- `idx_events_wall_ts` -- `(run_id, wall_ts)` for time-bucket queries
- `idx_events_system_event` -- `(run_id, system, event)` for filtering
- `idx_events_block_hash` -- `(run_id, (data->>'hash'))` for block lookups

### `ingest_offsets`

Per-file read offset. Used by the observer to resume after restart
without reprocessing lines.

| Column       | Type        |
|--------------|-------------|
| run_id       | TEXT        |
| session_id   | TEXT        |  or `'__coordinator__'` for coordinator.jsonl
| byte_offset  | BIGINT      |
| last_updated | TIMESTAMPTZ |

### `coordinator_events`

Unlogged mirror of the coordinator's own stream. Kept separately from
`events` because coordinator events are fleet-wide rather than
session-scoped.

## Running

```sh
deno run --allow-all harness/observer.ts <runs-root> <run-id> [postgres-url]
```

The observer writes no backpressure signal of its own today; if it
falls behind, the JSONL files on disk grow unbounded. Coordinator-side
enforcement of `observer.lag_threshold_bytes` is a known v1 gap
(see [TODO.md](../../TODO.md)).

## Manual queries

```sql
-- Count events by system.
SELECT system, count(*) FROM events
WHERE run_id = 'r-1776000000000'
GROUP BY system ORDER BY count DESC;

-- Block arrival order across the fleet.
SELECT session_id, wall_ts
FROM events
WHERE run_id = 'r-...'
  AND system = 'coordinator'
  AND event = 'blockReceived'
  AND data->>'hash' = 'abc12345..'
ORDER BY wall_ts;
```

See `harness/db/queries/*.sql` for canned queries.

## Resetting between runs

The `events` and `coordinator_events` tables are `UNLOGGED`. The
fastest way to reset is:

```sql
TRUNCATE events, coordinator_events, ingest_offsets, app_sessions, harness_runs RESTART IDENTITY;
```

This is safe to do whenever no run is in progress.
