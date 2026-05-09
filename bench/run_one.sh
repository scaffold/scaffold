#!/usr/bin/env bash
# Run one specific case. Usage: run_one.sh <impl> <mode> <conn>
set -uo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIG_BIN="$BENCH_DIR/zig-server/zig-out/bin/zig-server"
CPP_BIN="$BENCH_DIR/cpp-server/cpp-server"
LG_BIN="$BENCH_DIR/loadgen/zig-out/bin/loadgen"

MSGSIZE="${MSGSIZE:-512}"
WARMUP="${WARMUP:-3}"
DURATION="${DURATION:-8}"
SEEN_CAP="${SEEN_CAP:-1000000}"
ZIG_PORT=8080
CPP_PORT=8081

impl="$1"; mode="$2"; conn="$3"

if [[ "$impl" == "zig" ]]; then port="$ZIG_PORT"; bin="$ZIG_BIN"; else port="$CPP_PORT"; bin="$CPP_BIN"; fi

WORKLOAD="$mode" PORT="$port" SEEN_CAP="$SEEN_CAP" "$bin" > /tmp/srv.log 2>&1 &
SPID=$!; sleep 0.5
IDLE_RSS=$(ps -p $SPID -o rss= 2>/dev/null | tr -d ' ' || echo 0)

PORT="$port" CONNECTIONS="$conn" MSGSIZE="$MSGSIZE" WARMUP="$WARMUP" DURATION="$DURATION" "$LG_BIN" > /tmp/lg.out 2>&1 &
LPID=$!
sleep $((WARMUP + DURATION/2))
SERVER_CPU=$(ps -p $SPID -o %cpu= 2>/dev/null | tr -d ' ' || echo n/a)
SERVER_RSS=$(ps -p $SPID -o rss= 2>/dev/null | tr -d ' ' || echo 0)

# 60s ceiling -- give shutdown plenty of time for big seen-set teardown.
DEADLINE=$((SECONDS + 60))
while kill -0 $LPID 2>/dev/null; do
  if (( SECONDS >= DEADLINE )); then kill -9 $LPID 2>/dev/null || true; break; fi
  sleep 0.5
done
wait $LPID 2>/dev/null || true

result=$(grep "^RESULT" /tmp/lg.out | tail -1 || echo "FAILED-OR-HUNG")
printf "%-4s %-8s conn=%3d cpu=%6s%% rss_idle=%-7sKB rss_mid=%-9sKB %s\n" \
  "$impl" "$mode" "$conn" "$SERVER_CPU" "$IDLE_RSS" "$SERVER_RSS" "$result"

kill -9 $SPID 2>/dev/null || true
wait 2>/dev/null || true
