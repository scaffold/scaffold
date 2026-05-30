# Well-known blocks

Content-addressed blocks that every Scaffold node seeds into its store at
construction (alongside genesis), so they resolve offline without peer fetch.
Today this is the WASM blob blocks the JS runtime stacks.

## Layout

One directory per block. Each contains:

- `build.sh` — produces the artifact (e.g. `zig build`, vendor download) then
  bakes it into a block. Idempotent/memoized: re-running is cheap.
- `build.ts` — the Deno generator `build.sh` invokes. Constructs a network-free
  `Scaffold` (signed with the well-known key, anchored at genesis) and `put`s
  the block.
- `dist/block.bin` — the block's wire bytes (`block.raw`). Committed.
- `dist/hash.json` — `{ hash, blobHash }`. Drives memoization and the manifest.

`_lib/buildBlobBlock.ts` is the shared helper for blocks that publish a blob as
a `HASH_CONTRACT` block.

## Blocks

| Directory   | Block                                              | Source artifact                          |
|-------------|----------------------------------------------------|------------------------------------------|
| `wasi-shim` | `HASH_CONTRACT` block carrying `wasi-shim.wasm`    | `deno task build:wasi-shim`              |
| `quickjs`   | `HASH_CONTRACT` block carrying `qjs-wasi.wasm`     | `deno task vendor:quickjs`               |

## Building

```sh
deno task build:well-known     # builds all blocks (idempotent)
```

Or one at a time: `bash well-known-blocks/<name>/build.sh`.

## Loading

`src/wellKnown.ts` parses the committed `dist/block.bin` files via
`getWellKnownBlocks()` and exposes the blob hashes (`getShimBlobHash()`,
`getQuickjsBlobHash()`). `Scaffold` seeds these blocks by default
(`ScaffoldConfig.wellKnownBlocks`); pass `[]` to disable.

## Memoization & dependencies

Each `build.sh` skips regeneration when its input blob hash is unchanged
(compared against `dist/hash.json`). Because builds are cheap to re-run, a
future generator that depends on another block can simply call that block's
`build.sh` first. The set is currently flat (no inter-block dependencies), so
`build-all.sh` just runs each generator in turn.

> Browser note: `getWellKnownBlocks()` reads `dist/block.bin` via the
> filesystem (Deno). A browser build must bundle/inline these instead; until
> then a browser node falls back to peer fetch for blobs.
