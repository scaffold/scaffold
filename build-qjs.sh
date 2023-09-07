#!/bin/bash

set -e
set -x

OBJS=""

for file in /Users/joel/source/wasi-lab/qjs-wasi/src/cutils.c /Users/joel/source/wasi-lab/qjs-wasi/src/libregexp.c /Users/joel/source/wasi-lab/qjs-wasi/src/libunicode.c /Users/joel/source/wasi-lab/qjs-wasi/src/qjs.c /Users/joel/source/wasi-lab/qjs-wasi/src/quickjs-libc.c /Users/joel/source/wasi-lab/qjs-wasi/src/quickjs.c /Users/joel/source/wasi-lab/qjs-wasi/src/repl.c; do

# /Users/joel/.wasienv/bin/wasicc -DCONFIG_VERSION=\"2019-07-09\" -D_GNU_SOURCE  -Wall -Wextra -Wno-sign-compare -Wno-missing-field-initializers -Wundef -Wuninitialized -Wunused -Wno-unused-parameter -Wwrite-strings -Wchar-subscripts -funsigned-char  -Wall -Wextra -Wno-sign-compare -Wno-missing-field-initializers -Wundef -Wuninitialized -Wunused -Wno-unused-parameter -Wwrite-strings -Wchar-subscripts -funsigned-char -DNDEBUG -O2 -g -MD -MT CMakeFiles/qjs.dir/src/quickjs.c.obj -MF CMakeFiles/qjs.dir/src/quickjs.c.obj.d -o CMakeFiles/qjs.dir/src/quickjs.c.obj -c /Users/joel/source/wasi-lab/qjs-wasi/src/quickjs.c

  OBJ=$(mktemp)
  OBJS="${OBJS} ${OBJ}"

  ./wasi-sdk-20.0/bin/clang \
    -c "$file" \
    -DCONFIG_VERSION=\"2023-09-07\" \
    -D_WASI_EMULATED_SIGNAL \
    -D_WASI_EMULATED_PROCESS_CLOCKS \
    -I./wasi-sdk-20.0/share/wasi-sysroot/include/ \
    `#-std=c++17` \
    `#-g` \
    -O3 \
    -fno-exceptions \
    -fvisibility=hidden \
    -flto \
    -fno-rtti \
    --target=wasm32-wasi \
    --sysroot=./wasi-sdk-20.0/share/wasi-sysroot/ \
    -o "$OBJ" &
done

wait

# -Wl,--no-threads

./wasi-sdk-20.0/bin/clang \
  $OBJS \
  -I./wasi-sdk-20.0/share/wasi-sysroot/include/ \
  -lwasi-emulated-process-clocks \
  `#-std=c++17` \
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
  -o /Users/joel/proj/sublime/server/bootstrap/qjs.wasm

rm $OBJS

cd /Users/joel/proj/sublime

echo '53424c000000000000000000000000000000000000000000006a735f77617369' | xxd -r -p | wasm-custom-section "server/bootstrap/qjs.wasm" add scaffold_v0_wrapper_hash
mv server/bootstrap/qjs.wasm.out server/bootstrap/qjs.wasm

echo '040e717569636b6a73142f696e2f706172616d7300021c525553545f4241434b5452414345023100000004106964656e74697479000004066f75740c7374646f75740004066f75740c73746465727200' | xxd -r -p | wasm-custom-section "server/bootstrap/qjs.wasm" add scaffold_v0_wrapper_params
mv server/bootstrap/qjs.wasm.out server/bootstrap/qjs.wasm

printf '%s' _start | wasm-custom-section "server/bootstrap/qjs.wasm" add scaffold_v0_entry_funcs
mv server/bootstrap/qjs.wasm.out server/bootstrap/qjs.wasm
