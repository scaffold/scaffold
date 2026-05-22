// Protocol spec: docs/protocol/wasm-abi.md#default-atomics-over-sharedarraybuffer
//
// Default transport: worker pool + SharedArrayBuffer + Atomics.wait. Each
// call is one job on the pool. The main thread resolves `base.imports[mode]`
// to find the entry layer + export name, ships the compiled graph to the
// worker, and the worker instantiates + invokes.

import { type ContractEnv, ContractRejection } from '../../../core/ContractEnv.ts';
import type { BuilderHost, WalkerHost } from '../../../contracts/Contract.ts';
import type { WasmTransport } from '../WasmTransport.ts';
import {
  type BuildBridge,
  makeBuildBridge,
  makeRunBridge,
  makeWalkBridge,
  parseValueDescriptor,
  type RunBridge,
  type WalkBridge,
} from '../WasmHostBridge.ts';
import { encodeValueAndBody } from '../WasmWireCodec.ts';
import {
  type WasmPoolWorker,
  WasmWorkerPool,
  type WasmWorkerPoolConfig,
} from '../WasmWorkerPool.ts';
import type {
  WasmJobSpec,
  WasmLayerMsg,
  WasmSessionMode,
} from '../../../worker/wasm/wasmWorkerTypes.ts';
import type { WasmHostHandlers } from '../../../worker/wasm/WasmWorkerChannel.ts';
import type { CompiledModules, TargetRef } from '../WasmModules.ts';

// -- Per-call host-handler tables ---------------------------------

function runHandlers(bridge: RunBridge): WasmHostHandlers {
  return {
    contract_metadata: async ([verifier]) => await bridge.contractMetadata(verifier as Uint8Array),
    claim_next: async () => await bridge.claimNext(),
    claim_all: async ([limit]) => await bridge.claimAll(limit as number),
    emit_output: ([output]) => {
      bridge.send(output as Uint8Array);
    },
    request_body: async ([verifier]) => await bridge.request(verifier as Uint8Array),
    fetch: async ([verifier, key]) => await bridge.fetch(verifier as Uint8Array, key as Uint8Array),
    put: async ([verifier, records]) => {
      await bridge.put(verifier as Uint8Array, records as Uint8Array);
    },
    sign: ([pubkey]) => {
      bridge.sign(pubkey as Uint8Array);
    },
    // /out/debug routing for the WASI shim. Diagnostic-only; never traps.
    debug: ([message]) => {
      bridge.debug(message as Uint8Array);
    },
  };
}

function walkHandlers(bridge: WalkBridge): WasmHostHandlers {
  const boolByte = (b: boolean): Uint8Array => new Uint8Array([b ? 1 : 0]);
  return {
    emit_bytes: ([key, value, descBytes]) =>
      bridge.emitBytes(
        key as string,
        value as Uint8Array,
        parseValueDescriptor(descBytes as Uint8Array),
      ),
    emit_string: ([key, value, descBytes]) =>
      bridge.emitString(
        key as string,
        value as string,
        parseValueDescriptor(descBytes as Uint8Array),
      ),
    emit_number: ([key, value, descBytes]) =>
      bridge.emitNumber(
        key as string,
        value as number,
        parseValueDescriptor(descBytes as Uint8Array),
      ),
    emit_bool: ([key, value, descBytes]) =>
      bridge.emitBool(
        key as string,
        value as boolean,
        parseValueDescriptor(descBytes as Uint8Array),
      ),
    emit_map_start: ([key]) => boolByte(bridge.emitMapStart(key as string)),
    emit_map_end: () => bridge.emitMapEnd(),
    emit_list_start: ([key, count]) =>
      boolByte(bridge.emitListStart(key as string, count as number)),
    emit_list_end: () => bridge.emitListEnd(),
  };
}

function buildHandlers(bridge: BuildBridge): WasmHostHandlers {
  const encodeF64 = (v: number): Uint8Array => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, v, true);
    return buf;
  };
  const encodeI32 = (v: number): Uint8Array => {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setInt32(0, v, true);
    return buf;
  };
  return {
    request_bytes: ([key, descBytes]) =>
      bridge.requestBytes(key as string, parseValueDescriptor(descBytes as Uint8Array)),
    request_string: ([key, descBytes]) =>
      bridge.requestString(key as string, parseValueDescriptor(descBytes as Uint8Array)),
    request_number: ([key, descBytes]) =>
      encodeF64(bridge.requestNumber(key as string, parseValueDescriptor(descBytes as Uint8Array))),
    request_bool: ([key, descBytes]) =>
      new Uint8Array([
        bridge.requestBool(key as string, parseValueDescriptor(descBytes as Uint8Array)),
      ]),
    request_array_length: ([key, descBytes]) =>
      encodeI32(
        bridge.requestArrayLength(key as string, parseValueDescriptor(descBytes as Uint8Array)),
      ),
    begin_object: ([key]) => bridge.beginObject(key as string),
    end_object: () => bridge.endObject(),
    begin_array: ([key]) => bridge.beginArray(key as string),
    end_array: () => bridge.endArray(),
    validation_error: ([key, message]) => bridge.validationError(key as string, message as string),
  };
}

// -- Job helpers --------------------------------------------------

interface TerminalMsg {
  type: 'done' | 'reject' | 'crash';
  result?: Uint8Array;
  reason?: string;
  message?: string;
}

function awaitTerminal(worker: WasmPoolWorker): Promise<TerminalMsg> {
  return new Promise((resolve) => {
    worker.server.onTerminal((msg) => {
      const m = msg as TerminalMsg;
      resolve(m);
    });
  });
}

function postJob(worker: WasmPoolWorker, msg: WasmJobSpec): void {
  worker.worker.postMessage(msg);
}

function unwrapTerminal(msg: TerminalMsg, expectResult: boolean): Uint8Array | undefined {
  if (msg.type === 'reject') throw new ContractRejection(msg.reason ?? '');
  if (msg.type === 'crash') throw new Error(`wasm crash: ${msg.message ?? 'unknown'}`);
  return expectResult ? (msg.result ?? new Uint8Array(0)) : undefined;
}

function modulesToWorkerLayers(modules: CompiledModules): WasmLayerMsg[] {
  return modules.layers.map((l) => ({ key: l.key, module: l.module, imports: l.imports }));
}

function baseMemoriesAsRecord(
  modules: CompiledModules,
): Record<string, import('../WasmModules.ts').MemorySpec> | undefined {
  if (modules.base.memories.size === 0) return undefined;
  const out: Record<string, import('../WasmModules.ts').MemorySpec> = {};
  for (const [k, v] of modules.base.memories) out[k] = v;
  return out;
}

function lookupEntry(modules: CompiledModules, mode: WasmSessionMode): TargetRef {
  const ref = modules.base.imports.get(mode);
  if (!ref) {
    throw new Error(`modules.base.imports has no entry for mode ${JSON.stringify(mode)}`);
  }
  if (ref.layerKey === 'base') {
    throw new Error(
      `modules.base.imports[${JSON.stringify(mode)}]: target cannot be "base"`,
    );
  }
  return ref;
}

// -- Transport ----------------------------------------------------

export interface AtomicsWorkerTransportConfig extends WasmWorkerPoolConfig {
  /** Default job priority if a caller doesn't override. */
  defaultPriority?: number;
}

export class AtomicsWorkerTransport implements WasmTransport {
  private readonly pool: WasmWorkerPool;
  private readonly defaultPriority: number;

  constructor(config: AtomicsWorkerTransportConfig) {
    this.pool = new WasmWorkerPool(config);
    this.defaultPriority = config.defaultPriority ?? 0;
  }

  run(modules: CompiledModules, env: ContractEnv): Promise<void> {
    const bridge = makeRunBridge(env);
    const handlers = runHandlers(bridge);
    const preset = {
      executionMode: bridge.mode(),
      contractHash: bridge.contractHash(),
      params: bridge.params(),
      timestamp: bridge.timestamp(),
    };
    const layers = modulesToWorkerLayers(modules);
    const baseMemories = baseMemoriesAsRecord(modules);
    const entry = lookupEntry(modules, 'run');
    return this.pool.submit<void>({
      score: () => this.defaultPriority,
      run: async (worker) => {
        worker.server.setHandlers(handlers);
        const terminal = awaitTerminal(worker);
        postJob(worker, { type: 'instantiate', layers, entry, mode: 'run', baseMemories, preset });
        postJob(worker, { type: 'call' });
        unwrapTerminal(await terminal, false);
      },
    });
  }

  walkParams(modules: CompiledModules, params: Uint8Array, host: WalkerHost): Promise<void> {
    return this.runWalk(modules, 'walk_params', params, host);
  }

  walkData(modules: CompiledModules, data: Uint8Array, host: WalkerHost): Promise<void> {
    return this.runWalk(modules, 'walk_data', data, host);
  }

  buildParams(modules: CompiledModules, host: BuilderHost): Promise<Uint8Array> {
    return this.runBuild(modules, 'build_params', host);
  }

  buildData(modules: CompiledModules, host: BuilderHost): Promise<Uint8Array> {
    return this.runBuild(modules, 'build_data', host);
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  private runWalk(
    modules: CompiledModules,
    mode: 'walk_params' | 'walk_data',
    input: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    const bridge = makeWalkBridge(host);
    const handlers = walkHandlers(bridge);
    const layers = modulesToWorkerLayers(modules);
    const baseMemories = baseMemoriesAsRecord(modules);
    const entry = lookupEntry(modules, mode);
    return this.pool.submit<void>({
      score: () => this.defaultPriority,
      run: async (worker) => {
        worker.server.setHandlers(handlers);
        const terminal = awaitTerminal(worker);
        postJob(worker, { type: 'instantiate', layers, entry, mode, baseMemories });
        postJob(worker, { type: 'call', input });
        unwrapTerminal(await terminal, false);
      },
    });
  }

  private runBuild(
    modules: CompiledModules,
    mode: 'build_params' | 'build_data',
    host: BuilderHost,
  ): Promise<Uint8Array> {
    const bridge = makeBuildBridge(host);
    const handlers = buildHandlers(bridge);
    const layers = modulesToWorkerLayers(modules);
    const baseMemories = baseMemoriesAsRecord(modules);
    const entry = lookupEntry(modules, mode);
    return this.pool.submit<Uint8Array>({
      score: () => this.defaultPriority,
      run: async (worker) => {
        worker.server.setHandlers(handlers);
        const terminal = awaitTerminal(worker);
        postJob(worker, { type: 'instantiate', layers, entry, mode, baseMemories });
        postJob(worker, { type: 'call' });
        const bytes = unwrapTerminal(await terminal, true);
        return bytes ?? new Uint8Array(0);
      },
    });
  }
}

// Silence unused-import warning in some compile paths.
void encodeValueAndBody;
void ({} as WasmSessionMode);
