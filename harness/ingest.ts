/**
 * Batched postgres writer for harness events. Accepts parsed JSONL lines
 * via `push()`, flushes on batch_size or flush_interval_ms (whichever
 * first), or on demand.
 *
 * Works against the schema in harness/db/schema.sql. Inserts into `events`
 * as a multi-row INSERT in a single transaction.
 */

import postgres from 'postgres';
import type { RunId, SessionId } from './types.ts';

export interface IngestedEvent {
  runId: RunId;
  sessionId: SessionId;
  seq: number;
  wallTs: number;
  ts?: number;
  system: string;
  event: string;
  level?: string;
  kind?: string;
  data?: Record<string, unknown>;
}

export interface IngestOptions {
  postgresUrl: string;
  batchSize?: number;
  flushIntervalMs?: number;
  onError?: (err: Error) => void;
}

export class PgIngester {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly onError?: (err: Error) => void;
  private buf: IngestedEvent[] = [];
  private flushTimer: number | undefined;
  private closing = false;

  constructor(opts: IngestOptions) {
    this.sql = postgres(opts.postgresUrl, { max: 2, prepare: true });
    this.batchSize = opts.batchSize ?? 500;
    this.flushIntervalMs = opts.flushIntervalMs ?? 250;
    this.onError = opts.onError;
  }

  push(event: IngestedEvent): void {
    if (this.closing) return;
    this.buf.push(event);
    if (this.buf.length >= this.batchSize) {
      this.flush().catch((err) => this.onError?.(err as Error));
      return;
    }
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush().catch((err) => this.onError?.(err as Error));
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      // Multi-row INSERT via postgres.js helper. Pass `data` as a
      // pre-stringified JSON string; the schema column is jsonb and
      // postgres will cast string literals on input.
      const rows = batch.map((e) => [
        e.runId,
        e.sessionId,
        e.seq,
        e.wallTs,
        e.ts ?? null,
        e.system,
        e.event,
        e.level ?? 'info',
        e.kind ?? 'event',
        JSON.stringify(e.data ?? {}),
      ]);
      // deno-lint-ignore no-explicit-any
      const sqlAny = this.sql as any;
      await sqlAny.unsafe(
        `INSERT INTO events
           (run_id, session_id, seq, wall_ts, ts, system, event, level, kind, data)
         VALUES ${
          rows.map((_, i) => {
            const off = i * 10;
            return `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${
              off + 6
            }, $${off + 7}, $${off + 8}, $${off + 9}, $${off + 10}::jsonb)`;
          }).join(',')
        }
         ON CONFLICT (run_id, session_id, kind, seq) DO NOTHING`,
        rows.flat(),
      );
    } catch (err) {
      // Re-queue the batch so we don't lose data on transient pg errors.
      this.buf = batch.concat(this.buf);
      throw err;
    }
  }

  /** Upsert an app_sessions row. */
  async upsertSession(row: {
    runId: RunId;
    sessionId: SessionId;
    application: string;
    userPubkey?: string;
    address?: string;
    lat?: number;
    lon?: number;
    isAnchor: boolean;
    startedAt?: Date;
  }): Promise<void> {
    await this.sql`
      INSERT INTO app_sessions (
        run_id, session_id, application, user_pubkey, address,
        lat, lon, is_anchor, started_at
      ) VALUES (
        ${row.runId}, ${row.sessionId}, ${row.application},
        ${row.userPubkey ?? null}, ${row.address ?? null},
        ${row.lat ?? null}, ${row.lon ?? null},
        ${row.isAnchor}, ${row.startedAt ?? null}
      )
      ON CONFLICT (run_id, session_id) DO UPDATE SET
        application = EXCLUDED.application,
        user_pubkey = EXCLUDED.user_pubkey,
        address = EXCLUDED.address,
        lat = EXCLUDED.lat,
        lon = EXCLUDED.lon,
        is_anchor = EXCLUDED.is_anchor,
        started_at = COALESCE(app_sessions.started_at, EXCLUDED.started_at)
    `;
  }

  async markSessionEnded(
    runId: RunId,
    sessionId: SessionId,
    exitCode: number | null,
    exitSignal: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE app_sessions SET
        ended_at = now(),
        exit_code = ${exitCode},
        exit_signal = ${exitSignal}
      WHERE run_id = ${runId} AND session_id = ${sessionId}
    `;
  }

  async upsertRun(runId: RunId, configYaml: string, gitSha?: string): Promise<void> {
    await this.sql`
      INSERT INTO harness_runs (run_id, config_yaml, git_sha)
      VALUES (${runId}, ${configYaml}, ${gitSha ?? null})
      ON CONFLICT (run_id) DO UPDATE SET
        config_yaml = EXCLUDED.config_yaml,
        git_sha = EXCLUDED.git_sha
    `;
  }

  async markRunEnded(runId: RunId): Promise<void> {
    await this.sql`
      UPDATE harness_runs SET ended_at = now() WHERE run_id = ${runId}
    `;
  }

  async saveOffset(runId: RunId, sessionId: SessionId, offset: number): Promise<void> {
    await this.sql`
      INSERT INTO ingest_offsets (run_id, session_id, byte_offset)
      VALUES (${runId}, ${sessionId}, ${offset})
      ON CONFLICT (run_id, session_id) DO UPDATE SET
        byte_offset = EXCLUDED.byte_offset,
        last_updated = now()
    `;
  }

  async getOffsets(runId: RunId): Promise<Map<SessionId, number>> {
    const rows = await this.sql`
      SELECT session_id, byte_offset FROM ingest_offsets WHERE run_id = ${runId}
    ` as Array<{ session_id: string; byte_offset: string }>;
    const out = new Map<SessionId, number>();
    for (const r of rows) out.set(r.session_id, Number(r.byte_offset));
    return out;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      await this.flush();
    } finally {
      await this.sql.end();
    }
  }
}
