#!/usr/bin/env bash
# Build the WASI shim WASM blob. Outputs to `dist/wasi-shim.wasm`.
#
# We force the Zig cache into $TMPDIR so it doesn't try to write to
# ~/.cache (which the development sandbox restricts).
#
# Use `-d` for a debug build (preserves panic handlers and symbol names).

set -euo pipefail
cd "$(dirname "$0")"

mode="-Drelease"
if [[ "${1:-}" == "-d" || "${1:-}" == "--debug" ]]; then
  mode=""
fi

export ZIG_GLOBAL_CACHE_DIR="${TMPDIR:-/tmp}/zig-cache"
export ZIG_LOCAL_CACHE_DIR="${TMPDIR:-/tmp}/zig-cache"
mkdir -p "$ZIG_GLOBAL_CACHE_DIR"

zig build $mode
ls -la dist/wasi-shim.wasm
