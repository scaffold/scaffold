// Shared helper for well-known-blocks/*/build.ts generators that publish a
// content-addressed blob as a HASH_CONTRACT block.
//
// Idempotent/memoized: the block is regenerated only when the blob's hash
// differs from what `dist/hash.json` records. This keeps repeated builds cheap
// (so a future generator can call another generator's build.sh freely) and the
// committed `dist/block.bin` stable across runs.
//
// The block is produced by a network-free `Scaffold` signed with the well-known
// key and anchored at the well-known genesis -- the same recipe as src/genesis.ts.

import { Scaffold } from '../../src/Scaffold.ts';
import { HASH_CONTRACT } from '../../src/core/Block.ts';
import { DEFAULT_KEY } from '../../src/contracts/HashContract.ts';
import { WELL_KNOWN_PRIVATE_KEY } from '../../src/genesis.ts';
import { Hash } from '../../src/util/Hash.ts';

/** Metadata persisted to `dist/hash.json` alongside `dist/block.bin`. */
export interface BlockHashManifest {
  /** The generated block's hash (hex). */
  hash: string;
  /** The blob's content hash (hex) -- the HASH_CONTRACT verifier params. */
  blobHash: string;
}

/**
 * Build (or reuse) the HASH_CONTRACT block carrying `blob`, writing
 * `<blockDir>/dist/block.bin` and `<blockDir>/dist/hash.json`.
 *
 * @returns the manifest (whether freshly built or reused).
 */
export async function buildBlobBlock(opts: {
  /** The blob bytes to publish (e.g. a .wasm artifact). */
  blob: Uint8Array;
  /** Absolute path of the block's directory (its `dist/` is written here). */
  blockDir: string;
  /** Short label for log output. */
  label: string;
}): Promise<BlockHashManifest> {
  const blobHash = Hash.digest(opts.blob);
  const distDir = `${opts.blockDir}/dist`;
  const blockPath = `${distDir}/block.bin`;
  const hashPath = `${distDir}/hash.json`;

  // Memoize: skip when the blob is unchanged and the artifacts exist.
  const existing = await readManifest(hashPath);
  if (existing && existing.blobHash === blobHash.toHex() && await exists(blockPath)) {
    // deno-lint-ignore no-console
    console.log(`well-known/${opts.label}: up to date (blob ${blobHash.toHex().slice(0, 12)})`);
    return existing;
  }

  const scaffold = new Scaffold({
    privateKey: WELL_KNOWN_PRIVATE_KEY,
    enableLogging: false,
    enablePiggyback: false,
  });
  try {
    const block = await scaffold.put({
      contract: HASH_CONTRACT,
      params: blobHash.toBytes(),
      records: { [DEFAULT_KEY]: opts.blob },
    });
    const manifest: BlockHashManifest = {
      hash: block.hash.toHex(),
      blobHash: blobHash.toHex(),
    };
    await Deno.mkdir(distDir, { recursive: true });
    await Deno.writeFile(blockPath, block.raw);
    await Deno.writeTextFile(hashPath, JSON.stringify(manifest, null, 2) + '\n');
    // deno-lint-ignore no-console
    console.log(
      `well-known/${opts.label}: built block ${manifest.hash.slice(0, 12)} (blob ${
        manifest.blobHash.slice(0, 12)
      }, ${opts.blob.length} bytes)`,
    );
    return manifest;
  } finally {
    await scaffold.close();
  }
}

async function readManifest(path: string): Promise<BlockHashManifest | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as BlockHashManifest;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
