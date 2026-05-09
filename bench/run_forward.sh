#!/usr/bin/env bash
# Targeted: just run forward mode + fanout conn=64 to fill in the matrix.

set -uo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIG_BIN="$BENCH_DIR/zig-server/zig-out/bin/zig-server"
CPP_BIN="$BENCH_DIR/cpp-server/cpp-server"
LG_BIN="$BENCH_DIR/loadgen/zig-out/bin/loadgen"

MSGSIZE="${MSGSIZE:-512}"
WARMUP="${WARMUP:-3}"
DURATION="${DURATION:-8}"
ZIG_PORT=8080
CPP_PORT=8081

OUT_FILE="$BENCH_DIR/results/forward_$(date +%Y%m%d_%H%M%S).txt"
mkdir -p "$BENCH_DIR/results"
exec > >(tee "$OUT_FILE") 2>&1

run_case() {
  local impl="$1" mode="$2" conn="$3"
  local port bin
  if [[ "$impl" == "zig" ]]; then port="$ZIG_PORT"; bin="$ZIG_BIN"; else port="$CPP_PORT"; bin="$CPP_BIN"; fi

  WORKLOAD="$mode" PORT="$port" "$bin" > /tmp/srv.log 2>&1 &
  local SPID=$!
  sleep 0.5

  PORT="$port" CONNECTIONS="$conn" MSGSIZE="$MSGSIZE" WARMUP="$WARMUP" DURATION="$DURATION" "$LG_BIN" > /tmp/lg.out 2>&1 &
  local LPID=$!
  sleep $((WARMUP + DURATION/2))
  local SERVER_CPU
  SERVER_CPU=$(ps -p $SPID -o %cpu= 2>/dev/null | tr -d ' ' || echo n/a)

  # Hard 20s ceiling on the loadgen.
  local DEADLINE=$((SECONDS + 20))
  while kill -0 $LPID 2>/dev/null; do
    if (( SECONDS >= DEADLINE )); then
      kill -9 $LPID 2>/dev/null || true
      break
    fi
    sleep 0.5
  done
  wait $LPID 2>/dev/null || true

  local result
  result=$(grep "^RESULT" /tmp/lg.out | tail -1 || echo "FAILED-OR-HUNG")
  printf "%-4s %-8s conn=%3d srv_cpu=%s%% : %s\n" "$impl" "$mode" "$conn" "$SERVER_CPU" "$result"

  kill -9 $SPID 2>/dev/null || true
  wait 2>/dev/null || true
  sleep 1
}

echo "host: $(uname -m) $(uname -s)"
echo "cpu: Apple M1 Max, 10 cores"
echo "msgsize=$MSGSIZE warmup=${WARMUP}s duration=${DURATION}s"
echo

echo "=== forward (SHA3 + per-peer LRU dedup + broadcast) ==="
for conn in 8 16 32; do
  run_case zig forward $conn
  run_case cpp forward $conn
done

echo "results written to $OUT_FILE"
