// Protocol spec: docs/protocol/wasm-abi.md

import type { ImportPattern, MemorySpec, TargetRef } from '../../plugins/wasm/WasmModules.ts';

/**
 * Modes a single worker session can be configured for. Each maps to a
 * distinct set of WASM scaffold imports (`scaffold_env.*`,
 * `scaffold_walker.*`, `scaffold_builder.*`) and a distinct entry export.
 */
export type WasmSessionMode = 'run' | 'walk_params' | 'walk_data' | 'build_params' | 'build_data';

/** Sent from main -> worker to initialise channel buffers. */
export interface WasmInitMsg {
  type: 'init';
  sigBuf: SharedArrayBuffer;
  stagingBuf: SharedArrayBuffer;
}

/** One layer in the instantiate-message: compiled module + parsed import patterns. */
export interface WasmLayerMsg {
  key: string;
  module: WebAssembly.Module;
  imports: ImportPattern[];
}

/**
 * Sent from main -> worker to instantiate the module graph for one call.
 * `layers` is the full graph; `entry` is the `<layerKey, exportName>` the
 * worker invokes (looked up by the main thread from base.imports[mode]).
 */
export interface WasmInstantiateMsg {
  type: 'instantiate';
  layers: WasmLayerMsg[];
  entry: TargetRef;
  mode: WasmSessionMode;
  /**
   * Scaffold-provided memory specs (mirrors `compiled.base.memories`). The
   * worker creates fresh `WebAssembly.Memory` instances from these specs.
   */
  baseMemories?: Record<string, MemorySpec>;
  /** Pre-cached run-mode constants. Ignored for walk/build modes. */
  preset?: {
    executionMode: number;
    contractHash: Uint8Array;
    params: Uint8Array;
    timestamp: bigint;
  };
}

/** Sent from main -> worker to invoke the configured entry export. */
export interface WasmCallMsg {
  type: 'call';
  /** For walk_*: the input bytes to pass via (ptr, len). Otherwise undefined. */
  input?: Uint8Array;
}

/** Sent from main -> worker to dispose of resources. */
export interface WasmExitMsg {
  type: 'exit';
}

export type WasmJobSpec = WasmInitMsg | WasmInstantiateMsg | WasmCallMsg | WasmExitMsg;

/** Sent from worker -> main on session completion or failure. */
export interface WasmDoneMsg {
  type: 'done';
  result?: Uint8Array;
}
export interface WasmRejectMsg {
  type: 'reject';
  reason: string;
}
export interface WasmCrashMsg {
  type: 'crash';
  message: string;
}
export interface WasmHostInformMsg {
  type: 'host_inform';
  func: string;
  args: unknown[];
}
export interface WasmHostDispatchMsg {
  type: 'host_dispatch';
  func: string;
  args: unknown[];
}

export type WasmWorkerMsg =
  | WasmDoneMsg
  | WasmRejectMsg
  | WasmCrashMsg
  | WasmHostInformMsg
  | WasmHostDispatchMsg;
