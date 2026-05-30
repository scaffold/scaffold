#!/usr/bin/env -S deno run --allow-all
// Generate the well-known HASH_CONTRACT block carrying json-wb.wasm (the
// generic JSON walker/builder module). Run via ./build.sh (which builds the
// module first). Produces dist/block.bin and dist/hash.json.

import { buildBlobBlock } from '../_lib/buildBlobBlock.ts';

const blob = await Deno.readFile(
  new URL('../../src/contracts/json-wb/dist/json-wb.wasm', import.meta.url),
);
await buildBlobBlock({
  blob,
  blockDir: new URL('.', import.meta.url).pathname,
  label: 'json-wb',
});
