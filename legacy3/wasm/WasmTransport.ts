// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport

import type { ContractEnv } from '../../core/ContractEnv.ts';
import type { WalkerHost } from '../../contracts/Contract.ts';
import type { CompiledModules } from './WasmModules.ts';
import { Reader } from '../../contract/Reader.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';

/**
 * Single contract-execution boundary, independent of how host calls are
 * bridged across threads. Each method instantiates every layer of the
 * graph (with a runtime-supplied shared memory) and invokes the entry
 * export named by `base.imports[mode]`.
 *
 * Stacking ([wasm-abi.md#stacking](docs/protocol/wasm-abi.md#stacking)):
 *   - Every cross-layer / cross-scaffold reference is EXPLICIT in the
 *     `modules` record. No implicit defaults, no fallback.
 *   - JS forwarder closures bridge any cycles in the graph.
 *
 * Three implementations in v1:
 * - `AtomicsWorkerTransport` (default; SAB + Atomics.wait, requires COOP/COEP)
 * - `JspiTransport` (Chrome 137+; WebAssembly.Suspending)
 * - `InProcessMockTransport` (test/dev; sync-only -- throws if a may-block
 *   import is invoked without JSPI fallback)
 */
export interface WasmTransport {
  /**
   * Run the entry export named by `base.imports["run"]` against the given
   * env. Returns when the export returns; throws `ContractRejection` on
   * `scaffold_env.reject`, Error otherwise (crash).
   */
  run(modules: CompiledModules, env: ContractEnv): Promise<void>;

  /** Invoke `base.imports["walk_params"]` with the params bytes. */
  walkParams(
    modules: CompiledModules,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void>;

  /** Invoke `base.imports["walk_data"]` with the data bytes. */
  walkData(
    modules: CompiledModules,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void>;

  /** Invoke `base.imports["build_params"]` and return the contract-emitted bytes. */
  buildParams(
    modules: CompiledModules,
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array>;

  /** Invoke `base.imports["build_data"]` and return the contract-emitted bytes. */
  buildData(
    modules: CompiledModules,
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array>;

  /** Free any pooled resources (workers). Idempotent. */
  close(): Promise<void>;
}
