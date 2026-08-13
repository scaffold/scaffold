#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write
/**
 * Vendor the QuickJS-NG WASI binary used by the WASI shim shakedown test.
 *
 * Source of truth for URL + SHA-256 is `docs/design/wasi-programs.md`.
 * The binary is gitignored (it's in `tests/vendor/`); contributors run this
 * task once per checkout, then the cached file is reused.
 *
 * Behaviour:
 *   - If the destination file already exists with the expected SHA-256, no-op.
 *   - Otherwise, download via `curl -fsSL`, verify SHA-256, write to disk.
 *   - On size or SHA-256 mismatch, throws (does NOT write the bad bytes to
 *     disk, so a subsequent run starts clean).
 *
 * Usage: `deno task vendor:quickjs`
 */
import { encodeHex } from '@std/encoding/hex';

// Pinned per docs/design/wasi-programs.md ("QuickJS (in scope, v1 shakedown)").
const QUICKJS_URL = 'https://github.com/quickjs-ng/quickjs/releases/download/v0.14.0/qjs-wasi.wasm';
const QUICKJS_SHA256 = 'ba8727663e566b4acbe0ac61cb9caae2e880929042ffb8e21af6772034776c5e';
const QUICKJS_SIZE = 1_498_776;

// Destination is rooted at the repo (one level above `scripts/`).
const DEST_URL = new URL('../tests/vendor/quickjs/qjs.wasm', import.meta.url);
const DEST_PATH = DEST_URL.pathname;
const DEST_DIR = DEST_PATH.slice(0, DEST_PATH.lastIndexOf('/'));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return encodeHex(new Uint8Array(digest));
}

async function alreadyVendored(): Promise<boolean> {
  try {
    const bytes = await Deno.readFile(DEST_PATH);
    const got = await sha256Hex(bytes);
    return got === QUICKJS_SHA256;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function downloadWithCurl(url: string): Promise<Uint8Array> {
  // Stream into memory via stdout. `-f` fails on HTTP errors, `-sSL` follows
  // redirects quietly but still surfaces actual errors. We deliberately keep
  // curl in the loop (rather than `fetch`) so the task works the same way it
  // does in CI scripts and matches the contributor instructions.
  const cmd = new Deno.Command('curl', {
    args: ['-fsSL', url],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { success, stdout, stderr, code } = await cmd.output();
  if (!success) {
    const msg = new TextDecoder().decode(stderr).trim();
    throw new Error(`curl exited ${code}: ${msg || '(no stderr)'}`);
  }
  return stdout;
}

async function main(): Promise<void> {
  if (await alreadyVendored()) {
    // deno-lint-ignore no-console
    console.log(`vendor:quickjs: ${DEST_PATH} already present (sha256 OK).`);
    return;
  }

  // deno-lint-ignore no-console
  console.log(`vendor:quickjs: fetching ${QUICKJS_URL}`);
  const bytes = await downloadWithCurl(QUICKJS_URL);

  if (bytes.length !== QUICKJS_SIZE) {
    throw new Error(
      `vendor:quickjs: size mismatch (expected ${QUICKJS_SIZE}, got ${bytes.length})`,
    );
  }
  const got = await sha256Hex(bytes);
  if (got !== QUICKJS_SHA256) {
    throw new Error(
      `vendor:quickjs: sha256 mismatch\n  expected ${QUICKJS_SHA256}\n  got      ${got}`,
    );
  }

  await Deno.mkdir(DEST_DIR, { recursive: true });
  await Deno.writeFile(DEST_PATH, bytes);
  // deno-lint-ignore no-console
  console.log(`vendor:quickjs: wrote ${DEST_PATH} (${bytes.length} bytes, sha256 OK).`);
}

if (import.meta.main) {
  await main();
}
