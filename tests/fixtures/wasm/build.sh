#!/usr/bin/env bash
# Compile WAT fixtures to WASM. Requires `wat2wasm` from the WABT toolkit
# (https://github.com/WebAssembly/wabt; `brew install wabt` on macOS).
#
# Run from the repo root or this directory. Committed .wasm files are the
# build output of this script; regenerate them after editing any .wat.

set -euo pipefail

cd "$(dirname "$0")"

for wat in *.wat; do
  wasm="${wat%.wat}.wasm"
  echo "wat2wasm $wat -> $wasm"
  wat2wasm --enable-threads "$wat" -o "$wasm"
done
