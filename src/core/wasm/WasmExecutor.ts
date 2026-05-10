// Protocol spec: docs/protocol/wasm-abi.md
//
// Selects a `WasmTransport` at construction (config override > feature
// detection > Atomics default) and exposes the per-export entry points
// that `WasmContractAdapter` (A3) will call. Holds the transport instance
// over its lifetime so the worker pool amortises across calls.

import type { ContractEnv } from '../ContractEnv.ts';
import type { BuilderHost, WalkerHost } from '../../contracts/Contract.ts';
import type { WasmTransport } from './WasmTransport.ts';
import {
  AtomicsWorkerTransport,
  type AtomicsWorkerTransportConfig,
} from './transports/AtomicsWorkerTransport.ts';
import { InProcessMockTransport } from './transports/InProcessMockTransport.ts';
import { JspiTransport } from './transports/JspiTransport.ts';

export type TransportKind = 'auto' | 'atomics' | 'jspi' | 'in-process';

export interface WasmExecutorConfig {
  /** Transport selection. Defaults to 'auto'. */
  transport?: TransportKind;
  /** Required for 'atomics' / 'auto' resolving to atomics. */
  workerPath?: string | URL;
  /** Atomics-only. Default 4. */
  poolSize?: number;
  /** Atomics-only. Default 64 KiB. */
  stagingBufSize?: number;
}

/** Decide which concrete transport to construct. */
function resolveKind(config: WasmExecutorConfig): TransportKind {
  if (config.transport && config.transport !== 'auto') return config.transport;
  if (config.workerPath !== undefined && typeof Worker !== 'undefined') {
    return 'atomics';
  }
  if (JspiTransport.isSupported()) return 'jspi';
  return 'in-process';
}

function buildTransport(config: WasmExecutorConfig): WasmTransport {
  const kind = resolveKind(config);
  switch (kind) {
    case 'atomics': {
      if (config.workerPath === undefined) {
        throw new Error('AtomicsWorkerTransport requires `workerPath`');
      }
      const atomicsConfig: AtomicsWorkerTransportConfig = {
        workerPath: config.workerPath,
        poolSize: config.poolSize,
        stagingBufSize: config.stagingBufSize,
      };
      return new AtomicsWorkerTransport(atomicsConfig);
    }
    case 'jspi':
      return new JspiTransport();
    case 'in-process':
      return new InProcessMockTransport();
    default: {
      // exhaustive
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new Error(`unknown transport kind: ${kind}`);
    }
  }
}

export class WasmExecutor {
  private readonly _transport: WasmTransport;
  private readonly _kind: TransportKind;

  constructor(config: WasmExecutorConfig = {}) {
    this._kind = resolveKind(config);
    this._transport = buildTransport(config);
  }

  /** The transport kind actually selected (auto resolves to a concrete kind). */
  get kind(): TransportKind {
    return this._kind;
  }

  run(module: WebAssembly.Module, env: ContractEnv): Promise<void> {
    return this._transport.run(module, env);
  }

  walkParams(
    module: WebAssembly.Module,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    return this._transport.walkParams(module, params, host);
  }

  walkData(
    module: WebAssembly.Module,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    return this._transport.walkData(module, data, host);
  }

  buildParams(module: WebAssembly.Module, host: BuilderHost): Promise<Uint8Array> {
    return this._transport.buildParams(module, host);
  }

  buildData(module: WebAssembly.Module, host: BuilderHost): Promise<Uint8Array> {
    return this._transport.buildData(module, host);
  }

  close(): Promise<void> {
    return this._transport.close();
  }
}
