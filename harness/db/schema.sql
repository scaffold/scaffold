-- Scaffold harness schema.
-- `events` is UNLOGGED: harness runs don't need crash recovery, and
-- unlogged tables give ~2-3x higher insert throughput. Drop + recreate
-- between runs is cheap.

CREATE TABLE IF NOT EXISTS harness_runs (
  run_id          TEXT PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  config_yaml     TEXT,
  git_sha         TEXT
);

CREATE TABLE IF NOT EXISTS app_sessions (
  run_id          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  application     TEXT NOT NULL,
  user_pubkey     TEXT,
  address         TEXT,
  lat             DOUBLE PRECISION,
  lon             DOUBLE PRECISION,
  is_anchor       BOOLEAN NOT NULL DEFAULT false,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  exit_code       INTEGER,
  exit_signal     TEXT,
  PRIMARY KEY (run_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_app ON app_sessions(run_id, application);
CREATE INDEX IF NOT EXISTS idx_sessions_pubkey ON app_sessions(user_pubkey);

CREATE UNLOGGED TABLE IF NOT EXISTS events (
  run_id          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'event',
  seq             BIGINT NOT NULL,
  wall_ts         BIGINT NOT NULL,
  ts              DOUBLE PRECISION,
  system          TEXT NOT NULL,
  event           TEXT NOT NULL,
  level           TEXT NOT NULL DEFAULT 'info',
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, session_id, kind, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_wall_ts ON events(run_id, wall_ts);
CREATE INDEX IF NOT EXISTS idx_events_system_event ON events(run_id, system, event);
CREATE INDEX IF NOT EXISTS idx_events_block_hash ON events(run_id, (data->>'hash'));

-- Per-file ingest offsets so the observer can resume after a restart.
CREATE TABLE IF NOT EXISTS ingest_offsets (
  run_id          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  byte_offset     BIGINT NOT NULL,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, session_id)
);

-- Coordinator's own event log.
CREATE UNLOGGED TABLE IF NOT EXISTS coordinator_events (
  run_id          TEXT NOT NULL,
  seq             BIGSERIAL,
  wall_ts         BIGINT NOT NULL,
  event           TEXT NOT NULL,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, seq)
);
