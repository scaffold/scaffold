// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport

import type { ContractEnv } from '../../core/ContractEnv.ts';
import type { BuilderHost, WalkerHost } from '../../contracts/Contract.ts';
import type { CompiledStack } from './WasmLayers.ts';

/**
 * Single contract-execution boundary, independent of how host calls are
 * bridged across threads. Each method instantiates the full stack with a
 * runtime-supplied shared linear memory and runs the named export on the
 * top (primary) instance.
 *
 * Stacking ([wasm-abi.md#stacking](docs/protocol/wasm-abi.md#stacking)):
 *   - All layers share one `env.memory` import supplied by the transport.
 *   - Only the bottom layer sees the scaffold export view (`scaffold_env.*` /
 *     `scaffold_walker.*` / `scaffold_builder.*`, flattened).
 *   - Higher layers' imports resolve against the layer immediately below's
 *     `instance.exports`, optionally remapped via `mapImports`.
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
  run(stack: CompiledStack, env: ContractEnv): Promise<void>;

  /** Run `walk_params(params_ptr, params_len)` on the top instance. */
  walkParams(
    stack: CompiledStack,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void>;

  /** Run `walk_data(data_ptr, data_len)` on the top instance. */
  walkData(
    stack: CompiledStack,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void>;

  /** Run `build_params() -> i64`. Returns the bytes the contract emitted. */
  buildParams(stack: CompiledStack, host: BuilderHost): Promise<Uint8Array>;

  /** Run `build_data() -> i64`. Returns the bytes the contract emitted. */
  buildData(stack: CompiledStack, host: BuilderHost): Promise<Uint8Array>;

  /** Free any pooled resources (workers). Idempotent. */
  close(): Promise<void>;
}
