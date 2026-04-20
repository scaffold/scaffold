/**
 * Reliability + balance metrics.
 *
 *   clean_exit_pct              -- per non-anchor session: 1 if exit_code = 0
 *                                  and exit_signal IS NULL, else 0. Shared
 *                                  stat `mean` gives the ratio.
 *   errors_per_session          -- count of level='error' events per session
 *   balance_delta_per_session   -- per (app, contract) balance net change.
 *                                  Requires behaviors to emit
 *                                  { event: 'balance_change',
 *                                    data: { amount, contract } }.
 *                                  V1 returns no observations until wired.
 */

import type { Observation, Scope } from '../types.ts';
import type { Sql } from '../sql.ts';

export async function compute(sql: Sql, runId: string): Promise<Observation[]> {
  const obs: Observation[] = [];

  const sessions = await sql`
    SELECT session_id, application, is_anchor, exit_code, exit_signal
    FROM app_sessions WHERE run_id = ${runId}
  ` as Array<{
    session_id: string;
    application: string;
    is_anchor: boolean;
    exit_code: number | null;
    exit_signal: string | null;
  }>;
  const sessionApp = new Map<string, string>();
  for (const s of sessions) sessionApp.set(s.session_id, s.application);

  for (const s of sessions) {
    if (s.is_anchor) continue;
    if (s.exit_code === null && s.exit_signal === null) continue; // still running
    const clean = s.exit_signal === null && s.exit_code === 0 ? 1 : 0;
    obs.push({ metric: 'clean_exit_pct', scope: { kind: 'global' }, value: clean });
    obs.push({
      metric: 'clean_exit_pct',
      scope: { kind: 'app', app: s.application },
      value: clean,
    });
  }

  // Error events per session.
  const errorCounts = await sql`
    SELECT session_id, count(*) AS n
    FROM events
    WHERE run_id = ${runId} AND level = 'error'
    GROUP BY session_id
  ` as Array<{ session_id: string; n: string }>;
  const errorsBySession = new Map<string, number>();
  for (const r of errorCounts) errorsBySession.set(r.session_id, Number(r.n));

  for (const s of sessions) {
    const errs = errorsBySession.get(s.session_id) ?? 0;
    obs.push({ metric: 'errors_per_session', scope: { kind: 'global' }, value: errs });
    obs.push({
      metric: 'errors_per_session',
      scope: { kind: 'app', app: s.application },
      value: errs,
    });
  }

  // Balance delta per session, broken down by contract.
  const balanceRows = await sql`
    SELECT
      session_id,
      data->>'contract' AS contract,
      sum((data->>'amount')::DOUBLE PRECISION) AS delta
    FROM events
    WHERE run_id = ${runId}
      AND kind = 'app'
      AND event = 'balance_change'
      AND data ? 'amount'
      AND data ? 'contract'
    GROUP BY session_id, data->>'contract'
  ` as Array<{ session_id: string; contract: string; delta: string }>;

  for (const r of balanceRows) {
    const app = sessionApp.get(r.session_id) ?? 'unknown';
    const value = Number(r.delta);
    if (!Number.isFinite(value)) continue;
    const scopes: Scope[] = [
      { kind: 'global' },
      { kind: 'app', app },
      { kind: 'contract', contract: r.contract },
      { kind: 'app_contract', app, contract: r.contract },
    ];
    for (const scope of scopes) {
      obs.push({ metric: 'balance_delta_per_session', scope, value });
    }
  }

  return obs;
}
