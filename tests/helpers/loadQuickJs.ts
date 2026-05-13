// Test helper: loads the vendored QuickJS WASI binary used by the
// `WasiShimQuickJS` shakedown test. Mirrors `loadWasiShim.ts`.
//
// The binary is gitignored (it's in `tests/vendor/`); contributors run
// `deno task vendor:quickjs` once to populate the cache. Tests that need it
// should call `loadQuickJs()` rather than `Deno.readFile`-ing the path
// directly so they get a single read per process and a clear-action error
// message when the artifact is missing.

let cached: Promise<Uint8Array> | undefined;

const PATH = new URL('../vendor/quickjs/qjs.wasm', import.meta.url);

/**
 * Returns the QuickJS WASI bytes, cached per Deno process. Throws a
 * help-pointed error if the artifact is missing so the shakedown test can
 * skip cleanly on networkless CI.
 */
export function loadQuickJs(): Promise<Uint8Array> {
  if (cached === undefined) {
    cached = Deno.readFile(PATH).catch((err) => {
      // Reset so a later call (after the user runs the vendor task in
      // another shell) can retry instead of being permanently stuck.
      cached = undefined;
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(
          `quickjs: ${PATH.pathname} not found. ` +
            'Run `deno task vendor:quickjs` first.',
        );
      }
      throw err;
    });
  }
  return cached;
}
