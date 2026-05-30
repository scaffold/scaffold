#!/usr/bin/env bash
# Build every well-known block. Each block's build.sh is idempotent/memoized,
# so re-running is cheap. Add new blocks to the list below.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

for block in wasi-shim quickjs json-wb; do
  echo "== well-known-blocks/$block =="
  bash "$DIR/$block/build.sh"
done
