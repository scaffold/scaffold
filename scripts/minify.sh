#!/bin/sh

# Probably doesn't work
exit 1

npx terser \
  build/index.js \
  --compress drop_console=true,drop_debugger=true,ecma=2022,keep_fargs=false,keep_infinity=true,passes=4,pure_getters=true,toplevel=true \
  --mangle eval=true,toplevel=true \
  --toplevel \
  --output build/index.terser.min.js

# npx google-closure-compiler \
#   --js build/index.js \
#   --compilation_level ADVANCED \
#   --js_output_file build/index.google-closure-compiler.min.js

npx javascript-obfuscator \
  build/index.js \
  --output build/index.javascript-obfuscator.min.js \
  --compact true \
  --control-flow-flattening true \
  --dead-code-injection true \
  --debug-protection true \
  --debug-protection-interval 2000 \
  --disable-console-output true \
  --identifier-names-generator mangled-shuffled \
  --rename-globals true \
  --rename-properties true \
  --self-defending true \
  --string-array-calls-transform true \
  --string-array-encoding rc4 \
  --string-array-wrappers-type function \
  --target browser-no-eval \
  --transform-object-keys true

npx babel-minify \
  build/index.js \
  --out-file build/index.babel-minify.min.js

npx esbuild \
  build/index.js \
  --outfile=build/index.esbuild.min.js \
  --minify

npx uglify-js \
  build/index.js \
  --compress \
  --mangle \
  --toplevel \
  --output build/index.uglify.min.js

npx swc \
  build/index.js \
  --config-file swcrc.json \
  --out-file build/index.swc.min.js
