#!/usr/bin/env bash
# Generate the well-known json-wb HASH_CONTRACT block.
# Idempotent: build:json-wb rebuilds only when needed, and build.ts skips
# regeneration when the blob hash is unchanged.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

# 1. Build the json-wb.wasm artifact.
(cd "$ROOT" && deno task build:json-wb)

# 2. Bake it into a HASH_CONTRACT block.
deno run --allow-all "$DIR/build.ts"
