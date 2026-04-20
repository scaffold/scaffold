-- Block propagation timeline: for each block, list the sessions that
-- received it, with time-since-first-sighting.
--
-- Usage: psql -v run_id=r-... -v block_hash=deadbeef... -f block_propagation.sql

WITH recvs AS (
  SELECT
    session_id,
    wall_ts,
    data->>'fromPeer' AS from_peer
  FROM events
  WHERE run_id = :'run_id'
    AND system = 'network'
    AND event = 'blockReceived'
    AND data->>'hash' = :'block_hash'
),
ordered AS (
  SELECT
    session_id,
    from_peer,
    wall_ts,
    min(wall_ts) OVER () AS first_wall_ts
  FROM recvs
)
SELECT
  session_id,
  from_peer,
  wall_ts,
  wall_ts - first_wall_ts AS ms_after_first,
  row_number() OVER (ORDER BY wall_ts) AS arrival_rank
FROM ordered
ORDER BY wall_ts;
