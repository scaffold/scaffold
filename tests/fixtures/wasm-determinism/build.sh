#!/usr/bin/env bash
# Compile all .wat fixtures to .wasm using wat2wasm.
# The 'clean' fixture also gets a scaffold-transform-version custom section
# appended to mark it as "already transformed" -- the tool should return 0.
set -euo pipefail

cd "$(dirname "$0")"

for wat in *.wat; do
  base="${wat%.wat}"
  wat2wasm --enable-all "$wat" -o "$base.wasm"
done

# Post-process clean.wasm: append scaffold-transform-version custom section so
# that the tool returns 0 (already deterministic + already marked).
python3 - <<'PY'
import struct

def leb_u32(v):
    out = bytearray()
    while True:
        b = v & 0x7f
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)

name = b'scaffold-transform-version'
payload = b'20250510'
section_payload = leb_u32(len(name)) + name + payload
section = bytes([0]) + leb_u32(len(section_payload)) + section_payload

with open('clean.wasm', 'rb') as f:
    data = f.read()
with open('clean.wasm', 'wb') as f:
    f.write(data + section)
PY
