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

[ ! -d "wasi-sdk-20.0" ] && \
	curl -L https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-20/wasi-sdk-20.0-macos.tar.gz --output wasi-sdk-20.0-macos.tar.gz && \
	tar xvf wasi-sdk-20.0-macos.tar.gz && \
	rm wasi-sdk-20.0-macos.tar.gz

rm -f server/bootstrap/*

for file in ./cpp/wasi/*.cpp; do
	echo "$file"

	./wasi-sdk-20.0/bin/clang++ \
		"$file" \
		-I./cpp/ \
		-I./jsoncons/include/ \
		-I./wasi-sdk-20.0/share/wasi-sysroot/include/ \
		-std=c++17 \
		`#-g` \
    -O3 \
		-fno-exceptions \
		-fvisibility=hidden \
    -flto \
    -fno-rtti \
		--target=wasm32-wasi \
		--sysroot=./wasi-sdk-20.0/share/wasi-sysroot/ \
		`#-Wl,--export-all` \
		-Wl,--allow-undefined-file=syms.syms \
		`#-Wl,--export=malloc,--export=free` \
		`#-Wl,--growable-table` \
		`#-Wl,--export-table` \
		`#-Wl,--gc-sections` \
		`#-Wl,--no-entry` \
    -Wl,--strip-all \
		-Wl,--import-memory \
    -Wl,--shared-memory \
    -Wl,--no-check-features \
    `# -Wl,--initial-memory=4294967296` \
    -Wl,--max-memory=4294967296 \
		`#-Wl,-error-limit=0` \
		-o "server/bootstrap/$(basename "$file" .cpp).wasm" &
done

for file in ./cpp/*.cpp; do
	echo "$file"

	./wasi-sdk-20.0/bin/clang++ \
		"$file" \
		-I./cpp/ \
		-I./jsoncons/include/ \
		-I./wasi-sdk-20.0/share/wasi-sysroot/include/ \
		-std=c++17 \
		`#-g` \
    -O3 \
		-fno-exceptions \
		-fvisibility=hidden \
    -flto \
    -fno-rtti \
    -nostartfiles \
		--target=wasm32-wasi \
		--sysroot=./wasi-sdk-20.0/share/wasi-sysroot/ \
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
		-o "server/bootstrap/$(basename "$file" .cpp).wasm" &
done

for file in ./ts/*.generator.*.ts; do
	echo "$file"
	deno bundle "$file" | sed -r 's/export { ([_$a-zA-Z0-9\xA0-\uFFFF]+) as default };/return \1;/' > "server/bootstrap/$(basename "$file" .ts).js" &
done

for file in ./asm/*.asm.ts; do
	echo "$file"
	./assemblyscript/bin/asc.js "$file" --outFile "server/bootstrap/$(basename "$file" .asm.ts).wasm" &
done

curl 'https://registry-cdn.wapm.io/contents/python/python/0.1.0/bin/python.wasm' --continue-at - --output server/bootstrap/python.wasm &

sh build-qjs.sh

cp js/* server/bootstrap/ &
cp python/* server/bootstrap/ &
cp wasm/* server/bootstrap/ &

wait

for file in ./server/bootstrap/*.wasm; do
	echo "$file"
	echo '53424c000000000000000000000000000000000000000000006a735f77617369' | xxd -r -p | wasm-custom-section "$file" add scaffold_v0_wrapper_hash
	mv "$file".out "$file"
	echo '' | xxd -r -p | wasm-custom-section "$file" add scaffold_v0_wrapper_params
	mv "$file".out "$file"
done

deno run --allow-read --allow-write generateHashes.ts

wc -c server/bootstrap/*

# sh wasm.sh ;and env NODE_OPTIONS='--stack-trace-limit=100' npx ts-node-dev --experimental-wasm-threads --files src/entry/debug.ts
