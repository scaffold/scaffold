/**
 * Block propagation + throughput metrics.
 *
 *   block_propagation_ms          -- per block: time from first-seen
 *                                    anywhere to seen by 90% of
 *                                    "concurrently alive" sessions
 *   blocks_per_sec_per_session    -- throughput observation per
 *                                    session; value = block_count /
 *                                    session_duration_s
 *   contracts_per_sec_per_session -- same, but counting contractRan
 *                                    events from the scaffold
 *                                    execution subsystem
 */

import type { Observation, Scope } from '../types.ts';
import type { Sql } from '../sql.ts';

export async function compute(sql: Sql, runId: string): Promise<Observation[]> {
  const obs: Observation[] = [];

  const sessions = await sql`
    SELECT session_id, application, started_at, ended_at, is_anchor
    FROM app_sessions WHERE run_id = ${runId}
  ` as Array<{
    session_id: string;
    application: string;
    started_at: Date | null;
    ended_at: Date | null;
    is_anchor: boolean;
  }>;
  const sessionApp = new Map<string, string>();
  const sessionInterval = new Map<string, { startMs: number; endMs: number }>();
  for (const s of sessions) {
    sessionApp.set(s.session_id, s.application);
    if (s.started_at) {
      const startMs = s.started_at.getTime();
      const endMs = s.ended_at ? s.ended_at.getTime() : Number.MAX_SAFE_INTEGER;
      sessionInterval.set(s.session_id, { startMs, endMs });
    }
  }

  // Block propagation: per block hash, timestamps of receipt across
  // sessions. We then look up which sessions were "alive" at the block's
  // first-seen timestamp and compute time-to-90%-coverage over that set.
  const receipts = await sql`
    SELECT
      data->>'hash' AS hash,
      session_id,
      wall_ts
    FROM events
    WHERE run_id = ${runId}
      AND system = 'coordinator'
      AND event = 'blockReceived'
      AND data->>'hash' IS NOT NULL
    ORDER BY wall_ts
  ` as Array<{ hash: string; session_id: string; wall_ts: string }>;

  // Group receipts by block hash.
  const perBlock = new Map<string, Array<{ session_id: string; ms: number }>>();
  for (const r of receipts) {
    const ms = Number(r.wall_ts);
    if (!Number.isFinite(ms)) continue;
    let list = perBlock.get(r.hash);
    if (!list) {
      list = [];
      perBlock.set(r.hash, list);
    }
    list.push({ session_id: r.session_id, ms });
  }

  for (const [_hash, list] of perBlock) {
    if (list.length === 0) continue;
    list.sort((a, b) => a.ms - b.ms);
    const firstMs = list[0].ms;

    // Count sessions alive at firstMs (excluding the producer's session).
    let alive = 0;
    for (const iv of sessionInterval.values()) {
      if (iv.startMs <= firstMs && firstMs <= iv.endMs) alive++;
    }
    if (alive < 5) continue; // too small a fleet to reason about 90% coverage

    const target = Math.max(1, Math.ceil(alive * 0.9));
    const coverage = new Set<string>();
    let coverageMs: number | null = null;
    for (const r of list) {
      coverage.add(r.session_id);
      if (coverage.size >= target) {
        coverageMs = r.ms;
        break;
      }
    }
    if (coverageMs === null) continue; // never reached 90%

    const value = coverageMs - firstMs;
    obs.push({ metric: 'block_propagation_ms', scope: { kind: 'global' }, value });
  }

  // Per-session throughput observations: block count / session duration.
  const blockCounts = await sql`
    SELECT session_id, count(*) AS n
    FROM events
    WHERE run_id = ${runId}
      AND system = 'coordinator'
      AND event = 'blockReceived'
    GROUP BY session_id
  ` as Array<{ session_id: string; n: string }>;

  for (const r of blockCounts) {
    const iv = sessionInterval.get(r.session_id);
    if (!iv) continue;
    const ended = iv.endMs === Number.MAX_SAFE_INTEGER ? Date.now() : iv.endMs;
    const durS = (ended - iv.startMs) / 1000;
    if (durS <= 0) continue;
    const rate = Number(r.n) / durS;
    const app = sessionApp.get(r.session_id) ?? 'unknown';
    const scopes: Scope[] = [{ kind: 'global' }, { kind: 'app', app }];
    for (const scope of scopes) {
      obs.push({ metric: 'blocks_per_sec_per_session', scope, value: rate });
    }
  }

  // Contracts per second per session.
  const contractCounts = await sql`
    SELECT session_id, count(*) AS n
    FROM events
    WHERE run_id = ${runId}
      AND system = 'execution'
    GROUP BY session_id
  ` as Array<{ session_id: string; n: string }>;

  for (const r of contractCounts) {
    const iv = sessionInterval.get(r.session_id);
    if (!iv) continue;
    const ended = iv.endMs === Number.MAX_SAFE_INTEGER ? Date.now() : iv.endMs;
    const durS = (ended - iv.startMs) / 1000;
    if (durS <= 0) continue;
    const rate = Number(r.n) / durS;
    const app = sessionApp.get(r.session_id) ?? 'unknown';
    const scopes: Scope[] = [{ kind: 'global' }, { kind: 'app', app }];
    for (const scope of scopes) {
      obs.push({ metric: 'contracts_per_sec_per_session', scope, value: rate });
    }
  }

  return obs;
}
