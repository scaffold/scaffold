#!/bin/sh

set -e
set -x

# rm -rf src/gen/ cpp/gen/
# mkdir -p src/gen/ cpp/gen/

[ ! -d "jsoncons" ] && \
	git clone git@github.com:danielaparker/jsoncons.git

# node src/schema/main.js ../sbl.schema.js cpp > src/gen/sbl.h
# for file in ./cpp/*.schema.js; do
# 	node src/schema/main.js "../modules/$(basename "$file" .schema.js).schema.js" cpp > "cpp/gen/$(basename "$file" .schema.js).h"
# done

[ ! -d "wasi-sdk-17.0" ] && \
	curl -L https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-17/wasi-sdk-17.0-macos.tar.gz --output wasi-sdk-17.0-macos.tar.gz && \
	tar xvf wasi-sdk-17.0-macos.tar.gz && \
	rm wasi-sdk-17.0-macos.tar.gz

rm -f server/bootstrap/*.wasm

for file in ./cpp/*.cpp; do
	echo "$file"

	./wasi-sdk-17.0/bin/clang++ \
		"$file" \
		-I./cpp/ \
		-I./jsoncons/include/ \
		-I./wasi-sdk-17.0/share/wasi-sysroot/include/ \
		-std=c++17 \
		`#-g` \
    -O3 \
		-fno-exceptions \
		-fvisibility=hidden \
    -flto \
    -fno-rtti \
    -nostartfiles \
		--target=wasm32-unknown-wasi \
		--sysroot=./wasi-sdk-17.0/share/wasi-sysroot/ \
		`#-Wl,--export-all` \
		-Wl,--allow-undefined-file=syms.syms \
		`#-Wl,--export=malloc,--export=free` \
		`#-Wl,--growable-table` \
		`#-Wl,--export-table` \
		`#-Wl,--gc-sections` \
		-Wl,--no-entry \
    -Wl,--strip-all \
		-Wl,--import-memory \
    -Wl,--shared-memory \
    -Wl,--no-check-features \
    `# -Wl,--initial-memory=4294967296` \
    -Wl,--max-memory=4294967296 \
		`#-Wl,-error-limit=0` \
		-o "server/bootstrap/$(basename "$file" .cpp).wasm" # &
done

wait

deno run --allow-read --allow-write generateHashes.ts

wc -c server/bootstrap/*

# sh wasm.sh ;and env NODE_OPTIONS='--stack-trace-limit=100' npx ts-node-dev --experimental-wasm-threads --files src/entry/debug.ts
