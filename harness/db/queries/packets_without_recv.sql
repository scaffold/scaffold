-- Detect send events that lack a matching recv on the destination side.
-- This produces evidence of silent-leave drops (the harness's simulation
-- of a browser tab closing mid-flight).
--
-- Usage: psql -v run_id=r-... -f packets_without_recv.sql

WITH sends AS (
  SELECT
    session_id AS sender_session,
    data->>'block' AS block_hash,
    data->>'targetPeer' AS target_peer,
    wall_ts AS sent_at
  FROM events
  WHERE run_id = :'run_id'
    AND system = 'network'
    AND event = 'blockSent'
),
recvs AS (
  SELECT
    session_id AS recv_session,
    data->>'hash' AS block_hash,
    data->>'fromPeer' AS from_peer,
    wall_ts AS recv_at
  FROM events
  WHERE run_id = :'run_id'
    AND system = 'network'
    AND event = 'blockReceived'
)
SELECT
  s.sender_session,
  s.target_peer,
  s.block_hash,
  s.sent_at,
  count(r.recv_session) AS matched_recv_count
FROM sends s
LEFT JOIN recvs r
  ON r.block_hash = s.block_hash
 AND r.from_peer = (
    SELECT user_pubkey FROM app_sessions
    WHERE run_id = :'run_id' AND session_id = s.sender_session
 )
GROUP BY s.sender_session, s.target_peer, s.block_hash, s.sent_at
HAVING count(r.recv_session) = 0
ORDER BY s.sent_at DESC
LIMIT 200;
