import { BLOB_CONTRACT } from '../contract/static/Blob.ts';
import { Context } from '../Context.ts';
import { Hash } from '../util/Hash.ts';
import { CancelError } from '../util/RunQueue.ts';
import { Fetch } from './Fetch.ts';

// The BlobFetcher wired into WasmConfig: resolve a content-addressed blob
// through the ordinary Fetch path. Digest verification is mandatory -- block
// verification is not wired yet, so this is the only integrity gate. A
// mismatched answer keeps the subscription open rather than failing, since a
// correct answer may still arrive; a spoofed one is logged and skipped.
export function fetchBlob(ctx: Context, hash: Hash, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancelError('blob fetch aborted'));
      return;
    }
    const controller = new AbortController();
    signal.addEventListener('abort', () => {
      controller.abort();
      reject(new CancelError('blob fetch aborted'));
    });

    ctx.get(Fetch).fetch({
      contract: BLOB_CONTRACT,
      params: hash.toBytes(),
      signal: controller.signal,
      onResult: (result) => {
        if (result === null) return;
        if (!Hash.equals(Hash.digest(result.body), hash)) {
          ctx.logger('blob')?.warn('blobMismatch', { hash: hash.toHex() });
          return;
        }
        controller.abort();
        resolve(result.body);
      },
    }).catch(reject);
  });
}
