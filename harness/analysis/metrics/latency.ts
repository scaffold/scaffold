/**
 * Request/reply latency and fetch-unanswered metrics.
 *
 * Wiring expectation:
 *   Sender behavior emits  { kind: 'app', event: 'send_intent',
 *                            data: { requestId, destination, contract?, ... } }
 *   Recipient behavior emits { kind: 'app', event: 'reply',
 *                              data: { requestId } }
 *
 * The match is done on `data.requestId`. If a request has no matching
 * reply by the sender's session end, it contributes to
 * fetch_unanswered_pct but not to req_reply_latency_ms.
 *
 * Until behaviors are wired to emit `reply`, req_reply_latency_ms
 * returns no observations and is reported as uncovered.
 */

import type { Observation } from '../types.ts';
import type { Sql } from '../sql.ts';

export async function compute(sql: Sql, runId: string): Promise<Observation[]> {
  const obs: Observation[] = [];

  // Session-level app assignment lookup.
  const sessions = await sql`
    SELECT session_id, application FROM app_sessions WHERE run_id = ${runId}
  ` as Array<{ session_id: string; application: string }>;
  const sessionApp = new Map<string, string>();
  for (const s of sessions) sessionApp.set(s.session_id, s.application);

  // Request/reply pairs, joined by data->>'requestId'.
  const pairs = await sql`
    SELECT
      intents.session_id        AS sender_session,
      intents.wall_ts           AS intent_ts,
      intents.data->>'contract' AS contract,
      replies.wall_ts           AS reply_ts
    FROM events AS intents
    JOIN events AS replies
      ON replies.run_id = intents.run_id
     AND replies.kind = 'app'
     AND replies.event = 'reply'
     AND replies.data->>'requestId' = intents.data->>'requestId'
     AND replies.wall_ts >= intents.wall_ts
    WHERE intents.run_id = ${runId}
      AND intents.kind = 'app'
      AND intents.event = 'send_intent'
      AND intents.data ? 'requestId'
  ` as Array<
    { sender_session: string; intent_ts: string; contract: string | null; reply_ts: string }
  >;

  for (const p of pairs) {
    const latency = Number(p.reply_ts) - Number(p.intent_ts);
    if (!Number.isFinite(latency) || latency < 0) continue;
    const app = sessionApp.get(p.sender_session) ?? 'unknown';
    obs.push({ metric: 'req_reply_latency_ms', scope: { kind: 'global' }, value: latency });
    obs.push({ metric: 'req_reply_latency_ms', scope: { kind: 'app', app }, value: latency });
    if (p.contract) {
      obs.push({
        metric: 'req_reply_latency_ms',
        scope: { kind: 'contract', contract: p.contract },
        value: latency,
      });
      obs.push({
        metric: 'req_reply_latency_ms',
        scope: { kind: 'app_contract', app, contract: p.contract },
        value: latency,
      });
    }
  }

  // Fetch-unanswered fraction per session. We count all send_intents and
  // subtract the matched ones.
  const perSessionCounts = await sql`
    SELECT
      i.session_id,
      count(*) AS sent,
      count(r.*) AS replied
    FROM events i
    LEFT JOIN events r
      ON r.run_id = i.run_id
     AND r.kind = 'app'
     AND r.event = 'reply'
     AND r.data->>'requestId' = i.data->>'requestId'
    WHERE i.run_id = ${runId}
      AND i.kind = 'app'
      AND i.event = 'send_intent'
      AND i.data ? 'requestId'
    GROUP BY i.session_id
  ` as Array<{ session_id: string; sent: string; replied: string }>;

  for (const row of perSessionCounts) {
    const sent = Number(row.sent);
    const replied = Number(row.replied);
    if (sent === 0) continue;
    const unansweredPct = 1 - replied / sent;
    const app = sessionApp.get(row.session_id) ?? 'unknown';
    obs.push({ metric: 'fetch_unanswered_pct', scope: { kind: 'global' }, value: unansweredPct });
    obs.push({ metric: 'fetch_unanswered_pct', scope: { kind: 'app', app }, value: unansweredPct });
  }

  return obs;
}
