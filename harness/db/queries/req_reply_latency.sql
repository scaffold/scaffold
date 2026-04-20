-- Request/reply latency: joins each app's send_intent event to the
-- corresponding recv on the destination side and computes the delta.
-- Works for behaviors that emit send_intent / recv events with a shared
-- correlation key (extend as behaviors get real request/reply flows).
--
-- Usage: psql -v run_id=r-... -f req_reply_latency.sql

WITH intents AS (
  SELECT
    session_id AS sender_session,
    wall_ts AS intent_ts,
    data->>'destination' AS destination,
    data->>'requestId' AS request_id
  FROM events
  WHERE run_id = :'run_id'
    AND system = 'app'
    AND event = 'send_intent'
),
replies AS (
  SELECT
    session_id AS replier_session,
    wall_ts AS reply_ts,
    data->>'requestId' AS request_id
  FROM events
  WHERE run_id = :'run_id'
    AND system = 'app'
    AND event = 'reply'
)
SELECT
  i.sender_session,
  r.replier_session,
  i.destination,
  i.request_id,
  r.reply_ts - i.intent_ts AS latency_ms
FROM intents i
JOIN replies r USING (request_id)
ORDER BY latency_ms DESC
LIMIT 200;
