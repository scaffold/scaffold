// Test helper: loads the built `wasi-shim.wasm` blob and caches it for the
// rest of this Deno run.
//
// Why this exists: the WASI shim WASM is produced by a Zig build step, not by
// Deno itself. Tests that need the shim should call `loadWasiShim()` instead
// of reaching into `loadShim.ts:loadShim()` directly so they get:
//   1. A single read per `deno test` invocation (cached), and
//   2. A clear error message pointing at the build task when the artifact is
//      missing -- instead of the raw "file not found" from `loadShim()`.
//
// `deno task test` and `deno task test:wasi` both chain `build:wasi-shim`
// before running tests, so the artifact is normally fresh. This helper exists
// for ad-hoc invocations like `deno test --allow-all tests/WasiShim*.test.ts`.

import { loadShim } from '../../src/contracts/wasi-shim/loadShim.ts';

let cached: Promise<Uint8Array> | undefined;

/**
 * Returns the wasi-shim.wasm bytes, building-tip cached per Deno process.
 * Throws a help-pointed error if the artifact is missing.
 */
export function loadWasiShim(): Promise<Uint8Array> {
  if (cached === undefined) {
    cached = loadShim().catch((err) => {
      // Reset so a later call (e.g. after the user runs the build task in
      // another shell) can retry instead of being permanently stuck.
      cached = undefined;
      if (err instanceof Error && /not found/i.test(err.message)) {
        throw new Error(
          'wasi-shim: dist/wasi-shim.wasm not found. ' +
            'Run `deno task build:wasi-shim` (or `deno task test:wasi`) first.',
        );
      }
      throw err;
    });
  }
  return cached;
}
