// Well-known blocks: a small set of content-addressed blocks a Deno/CLI host
// can seed into its store (alongside genesis) so they resolve offline without
// peer fetch. Today this is the WASM blob blocks the JS runtime stacks: the
// wasi-shim, the QuickJS interpreter, and the json-wb codec.
//
// The blocks are generated deterministically by `well-known-blocks/*/build.sh`
// and committed as `well-known-blocks/<name>/dist/block.bin` (+ `hash.json`).
// This module loads those committed bytes via the filesystem.
//
// Deno-only: this module reads from disk and is excluded from the npm bundle
// (see scripts/build_npm.ts). The library no longer seeds well-known blocks
// automatically -- a Deno/CLI host passes `getWellKnownBlocks()` to
// `new Scaffold({ wellKnownBlocks })`. The browser ships no blocks and resolves
// blobs via peer fetch (or the dev demo seeds its own; see compilerHashes.ts).

import { AtomSource, Block, parseBlockPacket } from './core/Block.ts';
import { Hash } from './util/Hash.ts';

/** Names of the well-known block directories, in seed order. */
const WELL_KNOWN_NAMES = ['wasi-shim', 'quickjs', 'json-wb'] as const;
type WellKnownName = (typeof WELL_KNOWN_NAMES)[number];

interface BlockHashManifest {
  hash: string;
  blobHash: string;
}

const hasFs = typeof Deno !== 'undefined' && typeof Deno.readFileSync === 'function';

let _blocksCache: Block[] | null = null;
const _blobHashCache = new Map<string, Hash>();

/**
 * The well-known blocks to seed into a fresh node's store. Cached after first
 * load. Returns `[]` when the committed artifacts are unavailable (e.g. a fresh
 * checkout before `deno task build:well-known`, or a browser build).
 */
export function getWellKnownBlocks(): Block[] {
  if (_blocksCache) return _blocksCache;
  const blocks: Block[] = [];
  if (hasFs) {
    for (const name of WELL_KNOWN_NAMES) {
      const raw = tryReadFile(blockBinUrl(name));
      if (!raw) continue;
      const block = parseBlockPacket(raw, AtomSource.Local);
      if (block) blocks.push(block);
    }
  }
  _blocksCache = blocks;
  return blocks;
}

/**
 * The content hash of a well-known blob (the HASH_CONTRACT verifier params used
 * to reference it from a contract's `modules`). Throws if the block hasn't been
 * built. Use the named constants below for the common cases.
 */
export function wellKnownBlobHash(name: WellKnownName): Hash {
  const cached = _blobHashCache.get(name);
  if (cached) return cached;
  if (!hasFs) {
    throw new Error(`wellKnownBlobHash(${name}): no filesystem available to read manifest`);
  }
  const raw = tryReadFile(hashJsonUrl(name));
  if (!raw) {
    throw new Error(
      `wellKnownBlobHash(${name}): missing ${name}/dist/hash.json -- run deno task build:well-known`,
    );
  }
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as BlockHashManifest;
  const hash = Hash.fromHex(manifest.blobHash);
  _blobHashCache.set(name, hash);
  return hash;
}

/** Content hash of the wasi-shim.wasm blob. */
export function getShimBlobHash(): Hash {
  return wellKnownBlobHash('wasi-shim');
}

/** Content hash of the QuickJS (qjs-wasi) blob. */
export function getQuickjsBlobHash(): Hash {
  return wellKnownBlobHash('quickjs');
}

/** Content hash of the generic JSON walker/builder (json-wb) blob. */
export function getJsonWbBlobHash(): Hash {
  return wellKnownBlobHash('json-wb');
}

function blockBinUrl(name: WellKnownName): URL {
  return new URL(`../well-known-blocks/${name}/dist/block.bin`, import.meta.url);
}

function hashJsonUrl(name: WellKnownName): URL {
  return new URL(`../well-known-blocks/${name}/dist/hash.json`, import.meta.url);
}

function tryReadFile(url: URL): Uint8Array | null {
  try {
    return Deno.readFileSync(url);
  } catch {
    return null;
  }
}
