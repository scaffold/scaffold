#!/usr/bin/env bash
# Rebuild the committed .wasm fixtures. Requires WABT (wat2wasm).
set -euo pipefail
cd "$(dirname "$0")"
for f in *.wat; do
  wat2wasm "$f" -o "${f%.wat}.wasm"
done
