#!/usr/bin/env -S deno run --allow-all
// Generate the well-known HASH_CONTRACT block carrying the QuickJS (qjs-wasi)
// interpreter wasm. Run via ./build.sh (which vendors qjs first). Produces
// dist/block.bin and dist/hash.json.

import { buildBlobBlock } from '../_lib/buildBlobBlock.ts';

const blob = await Deno.readFile(
  new URL('../../tests/vendor/quickjs/qjs.wasm', import.meta.url),
);
await buildBlobBlock({
  blob,
  blockDir: new URL('.', import.meta.url).pathname,
  label: 'quickjs',
});
