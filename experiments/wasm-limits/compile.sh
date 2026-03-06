#!/bin/bash
set -e

mkdir -p wasm

echo "Compiling 100 WASM contracts..."
for i in $(seq 0 99); do
    zig build -Did=$i
    cp zig-out/bin/contract.wasm wasm/contract_${i}.wasm
    if (( i % 10 == 9 )); then
        echo "  compiled $((i+1))/100"
    fi
done

echo ""
echo "=== Size summary ==="
ls -la wasm/ | head -5
echo "..."
echo "Total files: $(ls wasm/*.wasm | wc -l)"
echo "Size range: $(ls -la wasm/*.wasm | awk '{print $5}' | sort -n | head -1) - $(ls -la wasm/*.wasm | awk '{print $5}' | sort -n | tail -1) bytes"
echo "Total size: $(du -sh wasm/ | awk '{print $1}')"
