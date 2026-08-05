// A transport's whole job: instantiate the module graph, wire a set of host
// functions in as imports, call one export, marshal bytes across the boundary.
//
// Exactly three things vary between transports:
//   1. how a possibly-async host fn is exposed to the guest (direct call /
//      WebAssembly.Suspending / Atomics round-trip to a worker),
//   2. how bytes cross into and out of guest memory (direct view vs SAB
//      staging buffer),
//   3. how the entry export is invoked.
//
// The ABI -- names, arities, which imports may block -- varies not at all,
// which is why it lives in WasmAbi.ts rather than being re-declared in each
// transport. Nothing here imports ContractEnv: a transport sees names, kinds
// and functions, never the env.

import { MaybePromise } from '../../util/MaybePromise.ts';

export type ValueKind = 'bytes' | 'str' | 'i32' | 'i64' | 'f64' | 'void';

type KindValue<K extends ValueKind> = K extends 'bytes' ? Uint8Array
  : K extends 'str' ? string
  : K extends 'i32' ? number
  : K extends 'i64' ? bigint
  : K extends 'f64' ? number
  : void;

type KindArgs<P extends ValueKind[]> = { [I in keyof P]: KindValue<P[I]> };

/**
 * A host function the guest may import, described well enough for a transport
 * to marshal it without knowing what it does.
 *
 * `call` is stored type-erased; declare through `hostFn` to keep inference at
 * the declaration site.
 */
export interface HostImport {
  params: ValueKind[];
  result: ValueKind;
  /**
   * May return a Promise, so the guest must be suspended across the call
   * (Suspending under JSPI, a blocking Atomics.wait under the worker
   * transport). Declared rather than inferred, because a transport wires its
   * imports before it can call any of them.
   */
  blocking: boolean;
  call(...args: never[]): MaybePromise<unknown>;
}

export type HostImports = Record<string, HostImport>;

/** Declare one import with its argument and result types checked against `params`/`result`. */
export const hostFn = <P extends ValueKind[], R extends ValueKind>(
  params: [...P],
  result: R,
  blocking: boolean,
  call: (...args: KindArgs<P>) => MaybePromise<KindValue<R>>,
): HostImport => ({ params, result, blocking, call });

export interface WasmTransport {
  /**
   * Instantiate `module` fresh, wire each `imports` table in under its
   * namespace, and call the export named `entry`.
   *
   * `arg` is the entry's single bytes argument where it takes one (walk_params
   * takes the params blob); the resolved value is its bytes result where it
   * has one (build_params returns the built blob). Entries with neither pass
   * and resolve `undefined`.
   *
   * `signal` is the only place an execution can actually be killed: the worker
   * transport terminates its worker, JSPI and in-process can at best refuse to
   * resume. Everything upstream (ExecutionQueue) can only ask.
   *
   * Throws ContractRejection when the guest calls `reject`, even if the guest
   * caught the resulting trap. Any other throw is a crash.
   */
  invoke(
    module: WebAssembly.Module,
    entry: string,
    imports: Record<string, HostImports>,
    opts?: { arg?: Uint8Array; signal?: AbortSignal },
  ): Promise<Uint8Array | undefined>;

  /** Free pooled resources. Idempotent. */
  close(): Promise<void>;
}
