// Deno-only: reads the built shim WASM off disk. Kept separate from
// `setup.ts` so the cross-runtime codec exports there stay in the npm build;
// this file is excluded from `scripts/build_npm.ts`.

/**
 * Read the built shim WASM from `src/contracts/wasi-shim/dist/wasi-shim.wasm`.
 * Throws if the file is missing -- run `zig build` in `src/contracts/wasi-shim`
 * (or `deno task build:wasi-shim`) to produce it.
 */
export async function loadShim(): Promise<Uint8Array> {
  const url = new URL('./dist/wasi-shim.wasm', import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `wasi-shim: dist/wasi-shim.wasm not found. ` +
          `Run \`cd src/contracts/wasi-shim && zig build\` first.`,
      );
    }
    throw err;
  }
}
