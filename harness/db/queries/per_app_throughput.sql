-- Per-application throughput: blocks received per minute, grouped by
-- the application type driving each session.
--
-- Usage: psql -v run_id=r-... -f per_app_throughput.sql

SELECT
  s.application,
  to_timestamp(e.wall_ts / 1000.0)::timestamptz AS bucket_minute,
  date_trunc('minute', to_timestamp(e.wall_ts / 1000.0)) AS minute,
  count(*) AS blocks_received
FROM events e
JOIN app_sessions s
  ON s.run_id = e.run_id AND s.session_id = e.session_id
WHERE e.run_id = :'run_id'
  AND e.system = 'coordinator'
  AND e.event = 'blockReceived'
GROUP BY s.application, bucket_minute, minute
ORDER BY minute, s.application;
