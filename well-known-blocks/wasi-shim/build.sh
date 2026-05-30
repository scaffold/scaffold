#!/usr/bin/env bash
# Generate the well-known wasi-shim HASH_CONTRACT block.
# Idempotent: build:wasi-shim is a no-op if up to date, and build.ts skips
# regeneration when the blob hash is unchanged.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

# 1. Produce the artifact (wasi-shim.wasm).
(cd "$ROOT" && deno task build:wasi-shim)

# 2. Bake it into a HASH_CONTRACT block.
deno run --allow-all "$DIR/build.ts"
