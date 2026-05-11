// Protocol spec: docs/protocol/wasm-abi.md#optional-jspi
//
// Same-thread WASM execution. Async scaffold imports wrap in
// `WebAssembly.Suspending`; the entry export is wrapped with
// `WebAssembly.promising`. Otherwise identical structure to the in-process
// transport: shared memory, loadModules, lookup entry via base.imports.

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
import { packPtrLen } from '../WasmWireCodec.ts';
import { type CompiledModules, loadModules, type TargetRef } from '../WasmModules.ts';

interface SuspendingCtor {
  new <Fn extends (...args: never[]) => unknown>(fn: Fn): Fn;
}
interface PromisingFn {
  <Fn extends (...args: never[]) => unknown>(fn: Fn): (
    ...args: Parameters<Fn>
  ) => Promise<ReturnType<Fn>>;
}
interface JspiAddons {
  Suspending?: SuspendingCtor;
  promising?: PromisingFn;
}
const jspi: JspiAddons = WebAssembly as unknown as JspiAddons;

interface InstanceCtx {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
}

function makeEmptyCtx(): InstanceCtx {
  return {
    memory: null as unknown as WebAssembly.Memory,
    alloc: () => {
      throw new Error('alloc called before instantiation');
    },
  };
}

function readSlice(ctx: InstanceCtx, ptr: number, len: number): Uint8Array {
  return new Uint8Array(ctx.memory.buffer, ptr, len).slice();
}

function readString(ctx: InstanceCtx, ptr: number, len: number): string {
  return new TextDecoder().decode(readSlice(ctx, ptr, len));
}

function allocAndWrite(ctx: InstanceCtx, bytes: Uint8Array): number {
  const ptr = ctx.alloc(bytes.length);
  new Uint8Array(ctx.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

function suspending<Fn extends (...args: never[]) => unknown>(fn: Fn): Fn {
  if (!jspi.Suspending) throw new Error('JSPI not supported in this runtime');
  return new jspi.Suspending(fn);
}

function promising<Fn extends (...args: never[]) => unknown>(
  fn: Fn,
): (...args: Parameters<Fn>) => Promise<ReturnType<Fn>> {
  if (!jspi.promising) throw new Error('JSPI not supported in this runtime');
  return jspi.promising(fn);
}

function makeSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 4096, shared: true });
}

function flatRunExports(ctx: InstanceCtx, bridge: RunBridge): Record<string, unknown> {
  const handlePackedAsync = async (bytes: Uint8Array | Promise<Uint8Array>): Promise<bigint> => {
    const resolved = await bytes;
    const ptr = allocAndWrite(ctx, resolved);
    return packPtrLen(ptr, resolved.length);
  };
  const handlePackedSync = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    mode: () => bridge.mode(),
    contract_hash: () => handlePackedSync(bridge.contractHash()),
    contract_metadata: suspending((vp: number, vl: number) =>
      handlePackedAsync(Promise.resolve(bridge.contractMetadata(readSlice(ctx, vp, vl))))
    ),
    params: () => handlePackedSync(bridge.params()),
    timestamp: () => bridge.timestamp(),
    claim_next: suspending(() => handlePackedAsync(Promise.resolve(bridge.claimNext()))),
    claim_all: suspending((limit: number) =>
      handlePackedAsync(Promise.resolve(bridge.claimAll(limit)))
    ),
    emit_output: (op: number, ol: number) => {
      bridge.emitOutput(readSlice(ctx, op, ol));
    },
    request_body: suspending((vp: number, vl: number) =>
      handlePackedAsync(Promise.resolve(bridge.requestBody(readSlice(ctx, vp, vl))))
    ),
    fetch: suspending((vp: number, vl: number, kp: number, kl: number) =>
      handlePackedAsync(
        Promise.resolve(bridge.fetch(readSlice(ctx, vp, vl), readSlice(ctx, kp, kl))),
      )
    ),
    fork: suspending(async (vp: number, vl: number, rp: number, rl: number) => {
      await bridge.fork(readSlice(ctx, vp, vl), readSlice(ctx, rp, rl));
    }),
    sign: (pp: number, pl: number) => {
      bridge.sign(readSlice(ctx, pp, pl));
    },
    reject: (rp: number, rl: number) => {
      bridge.reject(readSlice(ctx, rp, rl));
    },
  };
}

function flatWalkExports(ctx: InstanceCtx, bridge: WalkBridge): Record<string, unknown> {
  return {
    emit_bytes: (kp: number, kl: number, vp: number, vl: number, dp: number, dl: number) =>
      bridge.emitBytes(
        readString(ctx, kp, kl),
        readSlice(ctx, vp, vl),
        parseValueDescriptor(readSlice(ctx, dp, dl)),
      ),
    emit_string: (kp: number, kl: number, vp: number, vl: number, dp: number, dl: number) =>
      bridge.emitString(
        readString(ctx, kp, kl),
        readString(ctx, vp, vl),
        parseValueDescriptor(readSlice(ctx, dp, dl)),
      ),
    emit_number: (kp: number, kl: number, value: number, dp: number, dl: number) =>
      bridge.emitNumber(
        readString(ctx, kp, kl),
        value,
        parseValueDescriptor(readSlice(ctx, dp, dl)),
      ),
    emit_bool: (kp: number, kl: number, value: number, dp: number, dl: number) =>
      bridge.emitBool(
        readString(ctx, kp, kl),
        value !== 0,
        parseValueDescriptor(readSlice(ctx, dp, dl)),
      ),
    emit_map_start: (kp: number, kl: number) =>
      bridge.emitMapStart(readString(ctx, kp, kl)) ? 1 : 0,
    emit_map_end: () => bridge.emitMapEnd(),
    emit_list_start: (kp: number, kl: number, count: number) =>
      bridge.emitListStart(readString(ctx, kp, kl), count) ? 1 : 0,
    emit_list_end: () => bridge.emitListEnd(),
  };
}

function flatBuildExports(ctx: InstanceCtx, bridge: BuildBridge): Record<string, unknown> {
  const packBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    request_bytes: (kp: number, kl: number, dp: number, dl: number) =>
      packBytes(
        bridge.requestBytes(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      ),
    request_string: (kp: number, kl: number, dp: number, dl: number) =>
      packBytes(
        bridge.requestString(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      ),
    request_number: (kp: number, kl: number, dp: number, dl: number) =>
      bridge.requestNumber(readString(ctx, kp, kl), parseValueDescriptor(readSlice(ctx, dp, dl))),
    request_bool: (kp: number, kl: number, dp: number, dl: number) =>
      bridge.requestBool(readString(ctx, kp, kl), parseValueDescriptor(readSlice(ctx, dp, dl))),
    request_array_length: (kp: number, kl: number, dp: number, dl: number) =>
      bridge.requestArrayLength(
        readString(ctx, kp, kl),
        parseValueDescriptor(readSlice(ctx, dp, dl)),
      ),
    begin_object: (kp: number, kl: number) => bridge.beginObject(readString(ctx, kp, kl)),
    end_object: () => bridge.endObject(),
    begin_array: (kp: number, kl: number) => bridge.beginArray(readString(ctx, kp, kl)),
    end_array: () => bridge.endArray(),
    validation_error: (kp: number, kl: number, mp: number, ml: number) =>
      bridge.validationError(readString(ctx, kp, kl), readString(ctx, mp, ml)),
  };
}

interface EntryInfo {
  exports: Record<string, unknown>;
  exportName: string;
  layerKey: string;
}

function resolveEntry(
  modules: CompiledModules,
  exportsByKey: ReadonlyMap<string, Record<string, unknown>>,
  mode: string,
): EntryInfo {
  const ref: TargetRef | undefined = modules.base.imports.get(mode);
  if (!ref) {
    throw new Error(`modules.base.imports has no entry for mode ${JSON.stringify(mode)}`);
  }
  const exports = exportsByKey.get(ref.layerKey);
  if (!exports) {
    throw new Error(`modules.base.imports[${JSON.stringify(mode)}]: layer not found`);
  }
  return { exports, exportName: ref.exportName, layerKey: ref.layerKey };
}

function setCtxFromEntry(ctx: InstanceCtx, entry: EntryInfo, memory: WebAssembly.Memory): void {
  const alloc = entry.exports.alloc;
  if (typeof alloc !== 'function') {
    throw new Error(
      `entry layer ${JSON.stringify(entry.layerKey)} is missing required \`alloc\` export`,
    );
  }
  ctx.memory = memory;
  ctx.alloc = alloc as (size: number) => number;
}

export class JspiTransport implements WasmTransport {
  static isSupported(): boolean {
    return typeof jspi.Suspending === 'function' && typeof jspi.promising === 'function';
  }

  constructor() {
    if (!JspiTransport.isSupported()) {
      throw new Error('JSPI is not supported in this runtime');
    }
  }

  async run(modules: CompiledModules, env: ContractEnv): Promise<void> {
    const ctx = makeEmptyCtx();
    const memory = makeSharedMemory();
    const bridge = makeRunBridge(env);
    const scaffoldFlat = flatRunExports(ctx, bridge);
    const { exportsByKey } = await loadModules(modules, scaffoldFlat, memory);
    const entry = resolveEntry(modules, exportsByKey, 'run');
    setCtxFromEntry(ctx, entry, memory);
    const fn = entry.exports[entry.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`entry export ${JSON.stringify(entry.exportName)} not callable`);
    }
    const promisingFn = promising(fn as () => unknown);
    try {
      await promisingFn();
    } catch (err) {
      if (err instanceof ContractRejection) throw err;
      throw err;
    }
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
    return Promise.resolve();
  }

  private async runWalk(
    modules: CompiledModules,
    mode: 'walk_params' | 'walk_data',
    bytes: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    const ctx = makeEmptyCtx();
    const memory = makeSharedMemory();
    const bridge = makeWalkBridge(host);
    const scaffoldFlat = flatWalkExports(ctx, bridge);
    const { exportsByKey } = await loadModules(modules, scaffoldFlat, memory);
    const entry = resolveEntry(modules, exportsByKey, mode);
    setCtxFromEntry(ctx, entry, memory);
    const fn = entry.exports[entry.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`entry export ${JSON.stringify(entry.exportName)} not callable`);
    }
    const ptr = allocAndWrite(ctx, bytes);
    (fn as (p: number, l: number) => void)(ptr, bytes.length);
  }

  private async runBuild(
    modules: CompiledModules,
    mode: 'build_params' | 'build_data',
    host: BuilderHost,
  ): Promise<Uint8Array> {
    const ctx = makeEmptyCtx();
    const memory = makeSharedMemory();
    const bridge = makeBuildBridge(host);
    const scaffoldFlat = flatBuildExports(ctx, bridge);
    const { exportsByKey } = await loadModules(modules, scaffoldFlat, memory);
    const entry = resolveEntry(modules, exportsByKey, mode);
    setCtxFromEntry(ctx, entry, memory);
    const fn = entry.exports[entry.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`entry export ${JSON.stringify(entry.exportName)} not callable`);
    }
    const packed = (fn as () => bigint)();
    const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
    const len = Number(packed & 0xFFFFFFFFn);
    return readSlice(ctx, ptr, len);
  }
}
