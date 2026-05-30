#!/usr/bin/env -S deno run --allow-all
// Generate the well-known HASH_CONTRACT block carrying wasi-shim.wasm.
// Run via ./build.sh (which builds the shim first). Produces dist/block.bin
// and dist/hash.json.

import { buildBlobBlock } from '../_lib/buildBlobBlock.ts';

const blob = await Deno.readFile(
  new URL('../../src/contracts/wasi-shim/dist/wasi-shim.wasm', import.meta.url),
);
await buildBlobBlock({
  blob,
  blockDir: new URL('.', import.meta.url).pathname,
  label: 'wasi-shim',
});
