// The worker transport: the guest runs in a worker that Atomics.waits on a
// signal SAB whenever it needs a host result, so the main thread is never
// blocked and a hung or aborted execution can actually be killed by
// terminating the worker -- the only transport that can.
//
// Fire-and-forget imports (pure void sinks) reach the main thread as
// 'inform' messages; a host error there cannot trap the guest mid-flight, so
// it is recorded and thrown when the invoke settles instead.

import { error } from '../../util/functional.ts';
import { CancelError } from '../../util/RunQueue.ts';
import { ContractRejection } from '../ContractRejection.ts';
import { HostImports, WasmTransport } from './WasmTransport.ts';
import { WasmWorkerPool } from './WasmWorkerPool.ts';
import {
  encodeReply,
  FLAG_CONTINUE,
  FLAG_THROW,
  ImportDecl,
  MainToWorker,
  SIG_FLAG,
  SIG_LEN,
  WorkerToMain,
} from './WorkerChannel.ts';

export class AtomicsWorkerTransport implements WasmTransport {
  static isSupported(): boolean {
    // crossOriginIsolated exists only in browsers; when present it gates SAB.
    const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    return typeof Worker !== 'undefined' && typeof SharedArrayBuffer !== 'undefined' &&
      isolated !== false;
  }

  private pool: WasmWorkerPool;

  constructor(opts: { workerUrl?: URL; stagingBytes?: number } = {}) {
    this.pool = new WasmWorkerPool(
      opts.workerUrl ?? new URL('./worker/main.ts', import.meta.url),
      opts.stagingBytes ?? 64 * 1024,
    );
  }

  invoke(
    module: WebAssembly.Module,
    entry: string,
    imports: Record<string, HostImports>,
    opts?: { arg?: Uint8Array; signal?: AbortSignal },
  ): Promise<Uint8Array | undefined> {
    const signal = opts?.signal;
    if (signal?.aborted) return Promise.reject(new CancelError('wasm invoke aborted'));

    const decls: ImportDecl[] = Object.entries(imports).flatMap(([namespace, table]) =>
      Object.entries(table).map(([name, imp]) => ({
        namespace,
        name,
        params: imp.params,
        result: imp.result,
        blocking: imp.blocking,
      }))
    );

    const pooled = this.pool.acquire();
    const sig = new Int32Array(pooled.sigBuf);
    const staging = new Uint8Array(pooled.stagingBuf);
    const state: { rejection?: ContractRejection; fault?: Error } = {};

    return new Promise<Uint8Array | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (cb: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        cb();
      };

      const onAbort = () =>
        finish(() => {
          this.pool.discard(pooled);
          reject(new CancelError('wasm invoke aborted'));
        });
      signal?.addEventListener('abort', onAbort);

      const reply = (flag: number, payload: Uint8Array) => {
        staging.set(payload);
        Atomics.store(sig, SIG_LEN, payload.byteLength);
        Atomics.store(sig, SIG_FLAG, flag);
        Atomics.notify(sig, SIG_FLAG);
      };

      const record = (e: unknown): Error => {
        if (e instanceof ContractRejection) {
          state.rejection ??= e;
          return e;
        }
        const err = e instanceof Error ? e : new Error(String(e));
        state.fault ??= err;
        return err;
      };

      const invokeImport = (msg: { namespace: string; name: string; args: unknown[] }) => {
        const imp = imports[msg.namespace]?.[msg.name] ??
          error(`import ${msg.namespace}.${msg.name} is not available for this entry`);
        return { imp, value: (imp.call as (...a: unknown[]) => unknown)(...msg.args) };
      };

      const handleCall = async (msg: { namespace: string; name: string; args: unknown[] }) => {
        try {
          const { imp, value } = invokeImport(msg);
          const settledValue = await value;
          if (signal?.aborted) {
            throw new CancelError(`wasm invoke aborted during ${msg.namespace}.${msg.name}`);
          }
          const payload = encodeReply(imp.result, settledValue);
          if (payload.byteLength > staging.byteLength) {
            error(
              `reply to ${msg.namespace}.${msg.name} overflows the staging buffer ` +
                `(${payload.byteLength} > ${staging.byteLength})`,
            );
          }
          if (!settled) reply(FLAG_CONTINUE, payload);
        } catch (e) {
          const err = record(e);
          if (!settled) {
            reply(FLAG_THROW, new TextEncoder().encode(err.message).slice(0, staging.byteLength));
          }
        }
      };

      pooled.worker.onmessage = (event: MessageEvent) => {
        const msg = event.data as WorkerToMain;
        switch (msg.type) {
          case 'call':
            void handleCall(msg);
            break;
          case 'inform':
            try {
              const { value } = invokeImport(msg);
              if (value instanceof Promise) {
                error(`non-blocking import ${msg.namespace}.${msg.name} returned a promise`);
              }
            } catch (e) {
              record(e);
            }
            break;
          case 'done':
            finish(() => {
              this.pool.release(pooled);
              const err = state.rejection ?? state.fault;
              err !== undefined ? reject(err) : resolve(msg.result);
            });
            break;
          case 'crash':
            finish(() => {
              // A guest crash leaves the worker itself healthy.
              this.pool.release(pooled);
              reject(state.rejection ?? state.fault ?? new Error(`wasm crash: ${msg.message}`));
            });
            break;
        }
      };
      pooled.worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        finish(() => {
          this.pool.discard(pooled);
          reject(state.rejection ?? state.fault ?? new Error(`worker error: ${event.message}`));
        });
      };

      const exec: MainToWorker = { type: 'exec', module, entry, decls, arg: opts?.arg };
      pooled.worker.postMessage(exec);
    });
  }

  close(): Promise<void> {
    this.pool.close();
    return Promise.resolve();
  }
}
