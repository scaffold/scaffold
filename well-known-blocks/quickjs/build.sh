#!/usr/bin/env bash
# Generate the well-known QuickJS HASH_CONTRACT block.
# Idempotent: vendor:quickjs is a no-op when the pinned blob is already present,
# and build.ts skips regeneration when the blob hash is unchanged.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

# 1. Fetch the pinned qjs-wasi.wasm (SHA-256 checked).
(cd "$ROOT" && deno task vendor:quickjs)

# 2. Bake it into a HASH_CONTRACT block.
deno run --allow-all "$DIR/build.ts"
