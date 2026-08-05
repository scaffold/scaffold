// Instantiate and call on the main thread. A blocking import that actually
// returns a Promise is a hard error here -- there is no way to suspend real
// WASM without JSPI or a worker. Covers walks (sync by design), builds over
// sync sources, and run paths that never await.

import { assert, error } from '../../util/functional.ts';
import { CancelError } from '../../util/RunQueue.ts';
import { ContractRejection } from '../ContractRejection.ts';
import {
  buildImportObject,
  decodeArgs,
  encodeResult,
  GuestView,
  readBytes,
  resolveGuest,
  unpackPtrLen,
  writeBytes,
} from './lower.ts';
import { HostImports, WasmTransport } from './WasmTransport.ts';

export class InProcessTransport implements WasmTransport {
  async invoke(
    module: WebAssembly.Module,
    entry: string,
    imports: Record<string, HostImports>,
    opts?: { arg?: Uint8Array; signal?: AbortSignal },
  ): Promise<Uint8Array | undefined> {
    if (opts?.signal?.aborted) throw new CancelError('wasm invoke aborted');

    const state: { rejection?: ContractRejection; guest?: GuestView } = {};
    const g = () => state.guest ?? error('guest called an import before instantiation finished');

    const importObject = buildImportObject(
      module,
      imports,
      (ns, name, imp) => (...raw: unknown[]) => {
        try {
          const value = (imp.call as (...args: unknown[]) => unknown)(
            ...decodeArgs(g(), imp.params, raw),
          );
          if (value instanceof Promise) {
            error(`in-process transport cannot suspend on ${ns}.${name}`);
          }
          return encodeResult(g(), imp.result, value);
        } catch (e) {
          if (e instanceof ContractRejection) state.rejection ??= e;
          throw e;
        }
      },
    );

    const instance = await WebAssembly.instantiate(module, importObject);
    const guest = state.guest = resolveGuest(instance.exports);
    const fn = instance.exports[entry];
    assert(typeof fn === 'function', `guest does not export "${entry}"`);

    let result: unknown;
    try {
      if (opts?.arg !== undefined) {
        const { ptr, len } = writeBytes(guest, opts.arg);
        result = (fn as CallableFunction)(ptr, len);
      } else {
        result = (fn as CallableFunction)();
      }
    } catch (e) {
      // The guest may have caught the trap our import threw; the recorded
      // rejection still wins.
      throw state.rejection ?? e;
    }
    if (state.rejection !== undefined) throw state.rejection;

    if (typeof result === 'bigint') {
      const { ptr, len } = unpackPtrLen(result);
      return readBytes(guest, ptr, len);
    }
    assert(result === undefined, `entry "${entry}" returned an unexpected ${typeof result}`);
    return undefined;
  }

  async close() {}
}
