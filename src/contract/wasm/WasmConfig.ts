import { Context } from '../../Context.ts';
import { Hash } from '../../util/Hash.ts';

export type BlobFetcher = (ctx: Context, hash: Hash, signal: AbortSignal) => Promise<Uint8Array>;

// contract/ cannot import peer/, so the blob resolver is injected here; the
// implementation lives in peer/blobFetch.ts and is wired by Scaffold and
// makeTestContext.
export class WasmConfig {
  fetchBlob?: BlobFetcher;
  transport: 'auto' | 'inprocess' | 'jspi' | 'worker' = 'auto';
  workerUrl?: URL;
  stagingBytes = 64 * 1024;
}
