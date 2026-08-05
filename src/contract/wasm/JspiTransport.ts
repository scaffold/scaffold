// JSPI: blocking imports are wrapped in WebAssembly.Suspending at link time
// (the Suspending instance must be the literal import value), and the entry is
// driven through WebAssembly.promising. Not killable -- an abort only refuses
// to resume at the next blocking import; a guest suspended on a promise that
// never settles stays suspended.

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

// Not yet in the TS libs.
interface JspiWebAssembly {
  Suspending: new (fn: (...args: unknown[]) => Promise<unknown>) => object;
  promising: (fn: WebAssembly.ExportValue) => (...args: unknown[]) => Promise<unknown>;
}
const jspi = () => WebAssembly as unknown as JspiWebAssembly;

export class JspiTransport implements WasmTransport {
  static isSupported(): boolean {
    const w = WebAssembly as unknown as Record<string, unknown>;
    return typeof w.Suspending === 'function' && typeof w.promising === 'function';
  }

  constructor() {
    if (!JspiTransport.isSupported()) error('JSPI is not supported in this runtime');
  }

  async invoke(
    module: WebAssembly.Module,
    entry: string,
    imports: Record<string, HostImports>,
    opts?: { arg?: Uint8Array; signal?: AbortSignal },
  ): Promise<Uint8Array | undefined> {
    const signal = opts?.signal;
    if (signal?.aborted) throw new CancelError('wasm invoke aborted');

    const state: { rejection?: ContractRejection; guest?: GuestView } = {};
    const g = () => state.guest ?? error('guest called an import before instantiation finished');

    const importObject = buildImportObject(module, imports, (ns, name, imp) => {
      if (!imp.blocking) {
        return (...raw: unknown[]) => {
          try {
            const value = (imp.call as (...args: unknown[]) => unknown)(
              ...decodeArgs(g(), imp.params, raw),
            );
            if (value instanceof Promise) {
              error(`non-blocking import ${ns}.${name} returned a promise`);
            }
            return encodeResult(g(), imp.result, value);
          } catch (e) {
            if (e instanceof ContractRejection) state.rejection ??= e;
            throw e;
          }
        };
      }
      return new (jspi().Suspending)(async (...raw: unknown[]) => {
        try {
          if (signal?.aborted) throw new CancelError(`wasm invoke aborted at ${ns}.${name}`);
          const value = await (imp.call as (...args: unknown[]) => unknown)(
            ...decodeArgs(g(), imp.params, raw),
          );
          if (signal?.aborted) throw new CancelError(`wasm invoke aborted during ${ns}.${name}`);
          return encodeResult(g(), imp.result, value);
        } catch (e) {
          if (e instanceof ContractRejection) state.rejection ??= e;
          throw e;
        }
      });
    });

    const instance = await WebAssembly.instantiate(module, importObject);
    const guest = state.guest = resolveGuest(instance.exports);
    const fn = instance.exports[entry];
    assert(typeof fn === 'function', `guest does not export "${entry}"`);

    let result: unknown;
    try {
      if (opts?.arg !== undefined) {
        const { ptr, len } = writeBytes(guest, opts.arg);
        result = await jspi().promising(fn)(ptr, len);
      } else {
        result = await jspi().promising(fn)();
      }
    } catch (e) {
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
