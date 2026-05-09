#!/usr/bin/env bash
# Run full benchmark matrix with memory metrics.

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

OUT_FILE="$BENCH_DIR/results/matrix_$(date +%Y%m%d_%H%M%S).txt"
mkdir -p "$BENCH_DIR/results"
exec > >(tee "$OUT_FILE") 2>&1

echo "host: $(uname -m) $(uname -s)"
echo "cpu: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
echo "cores: $(sysctl -n hw.physicalcpu 2>/dev/null || echo ?) physical / $(sysctl -n hw.logicalcpu 2>/dev/null || echo ?) logical"
echo "msgsize=$MSGSIZE warmup=${WARMUP}s duration=${DURATION}s seen_cap=$SEEN_CAP"
echo "zig-server: $(stat -f%z "$ZIG_BIN") bytes"
echo "cpp-server: $(stat -f%z "$CPP_BIN") bytes"
echo

run_case() {
  local impl="$1" mode="$2" conn="$3"
  local port bin
  if [[ "$impl" == "zig" ]]; then port="$ZIG_PORT"; bin="$ZIG_BIN"; else port="$CPP_PORT"; bin="$CPP_BIN"; fi

  WORKLOAD="$mode" PORT="$port" SEEN_CAP="$SEEN_CAP" "$bin" > /tmp/srv.log 2>&1 &
  local SPID=$!
  sleep 0.5

  # Idle RSS just after listening
  local IDLE_RSS
  IDLE_RSS=$(ps -p $SPID -o rss= 2>/dev/null | tr -d ' ' || echo 0)

  PORT="$port" CONNECTIONS="$conn" MSGSIZE="$MSGSIZE" WARMUP="$WARMUP" DURATION="$DURATION" "$LG_BIN" > /tmp/lg.out 2>&1 &
  local LPID=$!

  # Sample CPU + RSS during measurement window
  sleep $((WARMUP + DURATION/2))
  local SERVER_CPU SERVER_RSS
  SERVER_CPU=$(ps -p $SPID -o %cpu= 2>/dev/null | tr -d ' ' || echo n/a)
  SERVER_RSS=$(ps -p $SPID -o rss= 2>/dev/null | tr -d ' ' || echo 0)

  # Hard 25s ceiling on the loadgen process.
  local DEADLINE=$((SECONDS + 25))
  while kill -0 $LPID 2>/dev/null; do
    if (( SECONDS >= DEADLINE )); then kill -9 $LPID 2>/dev/null || true; break; fi
    sleep 0.5
  done
  wait $LPID 2>/dev/null || true

  local result
  result=$(grep "^RESULT" /tmp/lg.out | tail -1 || echo "FAILED-OR-HUNG")
  printf "%-4s %-8s conn=%3d cpu=%6s%% rss_idle=%-7sKB rss_mid=%-9sKB %s\n" \
    "$impl" "$mode" "$conn" "$SERVER_CPU" "$IDLE_RSS" "$SERVER_RSS" "$result"

  kill -9 $SPID 2>/dev/null || true
  wait 2>/dev/null || true
  sleep 1
}

echo "=== echo (1:1, pure WS framing) ==="
for conn in 1 2 4 8; do
  run_case zig echo $conn
  run_case cpp echo $conn
done
echo
echo "=== hash (echo + SHA3-256) ==="
for conn in 1 2 4 8; do
  run_case zig hash $conn
  run_case cpp hash $conn
done
echo
echo "=== fanout (broadcast to all peers, no dedup) ==="
for conn in 8 16 32; do
  run_case zig fanout $conn
  run_case cpp fanout $conn
done
echo
echo "=== forward (SHA3 + per-peer LRU dedup + broadcast) ==="
for conn in 8 16 32; do
  run_case zig forward $conn
  run_case cpp forward $conn
done

echo
echo "results written to $OUT_FILE"
