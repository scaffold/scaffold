// Protocol spec: docs/protocol/wasm-abi.md
//
// Selects a `WasmTransport` at construction (config override > feature
// detection > Atomics default) and exposes the per-mode entry points
// `WasmContractAdapter` calls.

import type { ContractEnv } from '../../core/ContractEnv.ts';
import type { WalkerHost } from '../../contracts/Contract.ts';
import type { WasmTransport } from './WasmTransport.ts';
import type { CompiledModules } from './WasmModules.ts';
import {
  AtomicsWorkerTransport,
  type AtomicsWorkerTransportConfig,
} from './transports/AtomicsWorkerTransport.ts';
import { InProcessMockTransport } from './transports/InProcessMockTransport.ts';
import { JspiTransport } from './transports/JspiTransport.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { Reader } from '../../contract/Reader.ts';

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

type ConcreteTransportKind = Exclude<TransportKind, 'auto'>;

function resolveKind(config: WasmExecutorConfig): ConcreteTransportKind {
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

  get kind(): TransportKind {
    return this._kind;
  }

  run(modules: CompiledModules, env: ContractEnv): Promise<void> {
    return this._transport.run(modules, env);
  }

  walkParams(
    modules: CompiledModules,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    return this._transport.walkParams(modules, params, host);
  }

  walkData(
    modules: CompiledModules,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    return this._transport.walkData(modules, data, host);
  }

  buildParams(
    modules: CompiledModules,
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array> {
    return this._transport.buildParams(modules, host);
  }

  buildData(
    modules: CompiledModules,
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array> {
    return this._transport.buildData(modules, host);
  }

  close(): Promise<void> {
    return this._transport.close();
  }
}
