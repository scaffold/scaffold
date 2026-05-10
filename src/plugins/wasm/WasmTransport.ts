// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport

import type { ContractEnv } from '../../core/ContractEnv.ts';
import type { BuilderHost, WalkerHost } from '../../contracts/Contract.ts';

/**
 * Single contract-execution boundary, independent of how host calls are
 * bridged across threads. Each method instantiates a fresh WASM instance,
 * runs the named export, and returns when the export completes.
 *
 * Memory caps and budget enforcement are the caller's responsibility (see
 * `WasmContractAdapter` in A3 for the wiring): the transport itself takes
 * a module + an env/host and runs it.
 *
 * Three implementations in v1:
 * - `AtomicsWorkerTransport` (default; SAB + Atomics.wait, requires COOP/COEP)
 * - `JspiTransport` (Chrome 137+; WebAssembly.Suspending)
 * - `InProcessMockTransport` (test/dev; sync-only -- throws if a may-block
 *   import is invoked without JSPI fallback)
 */
export interface WasmTransport {
  /**
   * Run the contract's `run` export against the given env. Returns when
   * the export returns; throws `ContractRejection` on `scaffold_env.reject`,
   * Error otherwise (crash).
   */
  run(module: WebAssembly.Module, env: ContractEnv): Promise<void>;

  /** Run `walk_params(params_ptr, params_len)`. */
  walkParams(
    module: WebAssembly.Module,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void>;

  /** Run `walk_data(data_ptr, data_len)`. */
  walkData(
    module: WebAssembly.Module,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void>;

  /** Run `build_params() -> i64`. Returns the bytes the contract emitted. */
  buildParams(module: WebAssembly.Module, host: BuilderHost): Promise<Uint8Array>;

  /** Run `build_data() -> i64`. Returns the bytes the contract emitted. */
  buildData(module: WebAssembly.Module, host: BuilderHost): Promise<Uint8Array>;

  /** Free any pooled resources (workers). Idempotent. */
  close(): Promise<void>;
}
