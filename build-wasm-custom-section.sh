#!/bin/sh

set -e
set -x

env RUSTFLAGS="-C target-feature=+atomics,+bulk-memory -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--no-check-features -C link-arg=--max-memory=268435456" cargo build --target wasm32-wasi --release

echo '53424c000000000000000000000000000000000000000000006a735f77617369' | xxd -r -p | wasm-custom-section "target/wasm32-wasi/release/wasm-custom-section.wasm" add scaffold_v0_wrapper_hash
mv target/wasm32-wasi/release/wasm-custom-section.wasm.out target/wasm32-wasi/release/wasm-custom-section.wasm

echo '04267761736d2d637573746f6d2d73656374696f6e0868656c7000021c525553545f4241434b5452414345023100000004106964656e74697479000004066f75740c7374646f75740004066f75740c73746465727200' | xxd -r -p | wasm-custom-section "target/wasm32-wasi/release/wasm-custom-section.wasm" add scaffold_v0_wrapper_params
mv target/wasm32-wasi/release/wasm-custom-section.wasm.out target/wasm32-wasi/release/wasm-custom-section.wasm

printf '%s' _start | wasm-custom-section "target/wasm32-wasi/release/wasm-custom-section.wasm" add scaffold_v0_entry_funcs
mv target/wasm32-wasi/release/wasm-custom-section.wasm.out target/wasm32-wasi/release/wasm-custom-section.wasm

cp target/wasm32-wasi/release/wasm-custom-section.wasm ~/proj/sublime/server/bootstrap/wasm-custom-section.wasm