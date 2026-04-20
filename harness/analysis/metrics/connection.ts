/**
 * Connection-health metrics:
 *
 *   peers_per_session          -- one observation per session = peak
 *                                  concurrent peer count during the
 *                                  session's lifetime
 *   time_to_first_peer_ms      -- session `started` wall_ts to first
 *                                  `peer_connected` wall_ts
 *   time_to_first_block_ms     -- first `peer_connected` wall_ts to
 *                                  first `blockReceived` wall_ts
 */

import type { Observation, Scope } from '../types.ts';
import type { Sql } from '../sql.ts';

export async function compute(sql: Sql, runId: string): Promise<Observation[]> {
  const obs: Observation[] = [];

  const sessions = await sql`
    SELECT session_id, application FROM app_sessions WHERE run_id = ${runId}
  ` as Array<{ session_id: string; application: string }>;
  const sessionApp = new Map<string, string>();
  for (const s of sessions) sessionApp.set(s.session_id, s.application);

  // Peak concurrent peer count per session.
  const peakPeers = await sql`
    WITH deltas AS (
      SELECT
        session_id, wall_ts,
        CASE WHEN event = 'peer_connected' THEN 1 ELSE -1 END AS d
      FROM events
      WHERE run_id = ${runId}
        AND kind = 'app'
        AND event IN ('peer_connected', 'peer_disconnected')
    ),
    running AS (
      SELECT session_id, sum(d) OVER (PARTITION BY session_id ORDER BY wall_ts) AS cum
      FROM deltas
    )
    SELECT session_id, COALESCE(max(cum), 0)::INTEGER AS peak
    FROM running
    GROUP BY session_id
  ` as Array<{ session_id: string; peak: number }>;

  for (const r of peakPeers) {
    const app = sessionApp.get(r.session_id) ?? 'unknown';
    const scopes: Scope[] = [{ kind: 'global' }, { kind: 'app', app }];
    for (const scope of scopes) {
      obs.push({ metric: 'peers_per_session', scope, value: Number(r.peak) });
    }
  }

  // Time to first peer.
  const firstPeer = await sql`
    WITH starts AS (
      SELECT session_id, min(wall_ts) AS started_ts
      FROM events
      WHERE run_id = ${runId} AND kind = 'app' AND event = 'started'
      GROUP BY session_id
    ),
    first_peer AS (
      SELECT session_id, min(wall_ts) AS first_peer_ts
      FROM events
      WHERE run_id = ${runId} AND kind = 'app' AND event = 'peer_connected'
      GROUP BY session_id
    )
    SELECT s.session_id, first_peer.first_peer_ts - s.started_ts AS ms
    FROM starts s
    JOIN first_peer USING (session_id)
  ` as Array<{ session_id: string; ms: string }>;

  for (const r of firstPeer) {
    const app = sessionApp.get(r.session_id) ?? 'unknown';
    const value = Number(r.ms);
    if (!Number.isFinite(value) || value < 0) continue;
    obs.push({ metric: 'time_to_first_peer_ms', scope: { kind: 'global' }, value });
    obs.push({ metric: 'time_to_first_peer_ms', scope: { kind: 'app', app }, value });
  }

  // Time from first peer to first block received.
  const firstBlock = await sql`
    WITH first_peer AS (
      SELECT session_id, min(wall_ts) AS first_peer_ts
      FROM events
      WHERE run_id = ${runId} AND kind = 'app' AND event = 'peer_connected'
      GROUP BY session_id
    ),
    first_block AS (
      SELECT session_id, min(wall_ts) AS first_block_ts
      FROM events
      WHERE run_id = ${runId}
        AND system = 'coordinator'
        AND event = 'blockReceived'
        AND data->>'fromPeer' IS NOT NULL   -- blocks from the network, not genesis
      GROUP BY session_id
    )
    SELECT fp.session_id, fb.first_block_ts - fp.first_peer_ts AS ms
    FROM first_peer fp
    JOIN first_block fb USING (session_id)
  ` as Array<{ session_id: string; ms: string }>;

  for (const r of firstBlock) {
    const app = sessionApp.get(r.session_id) ?? 'unknown';
    const value = Number(r.ms);
    if (!Number.isFinite(value) || value < 0) continue;
    obs.push({ metric: 'time_to_first_block_ms', scope: { kind: 'global' }, value });
    obs.push({ metric: 'time_to_first_block_ms', scope: { kind: 'app', app }, value });
  }

  return obs;
}
