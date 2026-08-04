// Protocol spec: docs/protocol/wasm-abi.md#optional-jspi
//
// Same-thread WASM execution. Async scaffold imports wrap in
// `WebAssembly.Suspending`; the entry export is wrapped with
// `WebAssembly.promising`. Otherwise identical structure to the in-process
// transport: shared memory, loadModules, lookup entry via base.imports.

import { type ContractEnv, ContractRejection } from '../../../core/ContractEnv.ts';
import type { WalkerHost } from '../../../contracts/Contract.ts';
import type { Reader } from '../../../contract/Reader.ts';
import type { MaybePromise } from '../../../util/MaybePromise.ts';
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
import {
  asyncExport,
  type CompiledModules,
  type ExportEntry,
  loadModules,
  syncExport,
  type TargetRef,
} from '../WasmModules.ts';

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

function promising<Fn extends (...args: never[]) => unknown>(
  fn: Fn,
): (...args: Parameters<Fn>) => Promise<ReturnType<Fn>> {
  if (!jspi.promising) throw new Error('JSPI not supported in this runtime');
  return jspi.promising(fn);
}

function flatRunExports(ctx: InstanceCtx, bridge: RunBridge): Record<string, ExportEntry> {
  const handlePackedAsync = async (bytes: Uint8Array | Promise<Uint8Array>): Promise<bigint> => {
    const resolved = await bytes;
    const ptr = allocAndWrite(ctx, resolved);
    return packPtrLen(ptr, resolved.length);
  };
  const handlePackedSync = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  // Each entry's kind drives the Suspending wrapping in loadModules. The
  // async entries below were previously eagerly wrapped via `new
  // Suspending(...)` here; we now hand the raw async fns to loadModules,
  // which Suspending-wraps the forwarder at wire time.
  return {
    mode: syncExport(() => bridge.mode()),
    contract_hash: syncExport(() => handlePackedSync(bridge.contractHash())),
    contract_metadata: asyncExport((vp: number, vl: number) =>
      handlePackedAsync(Promise.resolve(bridge.contractMetadata(readSlice(ctx, vp, vl))))
    ),
    params: syncExport(() => handlePackedSync(bridge.params())),
    timestamp: syncExport(() => bridge.timestamp()),
    claim_next: asyncExport(() => handlePackedAsync(Promise.resolve(bridge.claimNext()))),
    claim_all: asyncExport((limit: number) =>
      handlePackedAsync(Promise.resolve(bridge.claimAll(limit)))
    ),
    emit_output: syncExport((op: number, ol: number) => {
      bridge.send(readSlice(ctx, op, ol));
    }),
    request_body: asyncExport((vp: number, vl: number) =>
      handlePackedAsync(Promise.resolve(bridge.request(readSlice(ctx, vp, vl))))
    ),
    fetch: asyncExport((vp: number, vl: number, kp: number, kl: number) =>
      handlePackedAsync(
        Promise.resolve(bridge.fetch(readSlice(ctx, vp, vl), readSlice(ctx, kp, kl))),
      )
    ),
    put: asyncExport(async (vp: number, vl: number, rp: number, rl: number) => {
      await bridge.put(readSlice(ctx, vp, vl), readSlice(ctx, rp, rl));
    }),
    sign: syncExport((pp: number, pl: number) => {
      bridge.sign(readSlice(ctx, pp, pl));
    }),
    // /out/debug routing for the WASI shim. Diagnostic-only; never traps.
    debug: syncExport((rp: number, rl: number) => {
      bridge.debug(readSlice(ctx, rp, rl));
    }),
    reject: syncExport((rp: number, rl: number) => {
      bridge.reject(readSlice(ctx, rp, rl));
    }),
  };
}

function asSyncEntries<T extends Record<string, (...args: never[]) => unknown>>(
  obj: T,
): Record<string, ExportEntry> {
  const out: Record<string, ExportEntry> = {};
  for (const [k, fn] of Object.entries(obj)) out[k] = syncExport(fn);
  return out;
}

function flatWalkExports(ctx: InstanceCtx, bridge: WalkBridge): Record<string, ExportEntry> {
  return asSyncEntries({
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
  });
}

function flatBuildExports(ctx: InstanceCtx, bridge: BuildBridge): Record<string, ExportEntry> {
  const handlePackedAsync = async (bytes: Uint8Array | Promise<Uint8Array>): Promise<bigint> => {
    const resolved = await bytes;
    const ptr = allocAndWrite(ctx, resolved);
    return packPtrLen(ptr, resolved.length);
  };
  // Build bridge calls are MaybePromise; JSPI suspends on them like the run
  // path, so each value request is an asyncExport (Suspending-wrapped at wire
  // time) and the cursor's `end_*` stay sync.
  return {
    request_bytes: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      handlePackedAsync(
        Promise.resolve(
          bridge.requestBytes(
            readString(ctx, kp, kl),
            parseValueDescriptor(readSlice(ctx, dp, dl)),
          ),
        ),
      )
    ),
    request_string: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      handlePackedAsync(
        Promise.resolve(
          bridge.requestString(
            readString(ctx, kp, kl),
            parseValueDescriptor(readSlice(ctx, dp, dl)),
          ),
        ),
      )
    ),
    request_number: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      Promise.resolve(
        bridge.requestNumber(readString(ctx, kp, kl), parseValueDescriptor(readSlice(ctx, dp, dl))),
      )
    ),
    request_bool: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      Promise.resolve(
        bridge.requestBool(readString(ctx, kp, kl), parseValueDescriptor(readSlice(ctx, dp, dl))),
      )
    ),
    request_array_length: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      Promise.resolve(
        bridge.requestArrayLength(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      )
    ),
    request_value_type: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      Promise.resolve(
        bridge.requestValueType(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      )
    ),
    request_object_keys: asyncExport((kp: number, kl: number, dp: number, dl: number) =>
      handlePackedAsync(
        Promise.resolve(
          bridge.requestObjectKeys(
            readString(ctx, kp, kl),
            parseValueDescriptor(readSlice(ctx, dp, dl)),
          ),
        ),
      )
    ),
    begin_object: asyncExport((kp: number, kl: number) =>
      Promise.resolve(bridge.beginObject(readString(ctx, kp, kl)))
    ),
    end_object: syncExport(() => bridge.endObject()),
    begin_array: asyncExport((kp: number, kl: number) =>
      Promise.resolve(bridge.beginArray(readString(ctx, kp, kl)))
    ),
    end_array: syncExport(() => bridge.endArray()),
    validation_error: syncExport((kp: number, kl: number, mp: number, ml: number) =>
      bridge.validationError(readString(ctx, kp, kl), readString(ctx, mp, ml))
    ),
  };
}

interface EntryInfo {
  exports: Record<string, unknown>;
  exportName: string;
  layerKey: string;
}

function lookupEntryRef(modules: CompiledModules, mode: string): TargetRef {
  const ref: TargetRef | undefined = modules.base.imports.get(mode);
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

function resolveEntry(
  modules: CompiledModules,
  exportsByKey: ReadonlyMap<string, Record<string, unknown>>,
  mode: string,
): EntryInfo {
  const ref = lookupEntryRef(modules, mode);
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
    const bridge = makeRunBridge(env);
    const scaffoldFlat = flatRunExports(ctx, bridge);
    const entryRef = lookupEntryRef(modules, 'run');
    const { exportsByKey, entryMemory } = await loadModules(modules, scaffoldFlat, entryRef);
    const entry = resolveEntry(modules, exportsByKey, 'run');
    setCtxFromEntry(ctx, entry, entryMemory);
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

  buildParams(
    modules: CompiledModules,
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array> {
    return this.runBuild(modules, 'build_params', host);
  }

  buildData(
    modules: CompiledModules,
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array> {
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
    const bridge = makeWalkBridge(host);
    const scaffoldFlat = flatWalkExports(ctx, bridge);
    const entryRef = lookupEntryRef(modules, mode);
    const { exportsByKey, entryMemory } = await loadModules(modules, scaffoldFlat, entryRef);
    const entry = resolveEntry(modules, exportsByKey, mode);
    setCtxFromEntry(ctx, entry, entryMemory);
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
    host: (descriptor: string) => MaybePromise<Reader>,
  ): Promise<Uint8Array> {
    const ctx = makeEmptyCtx();
    const bridge = makeBuildBridge(host);
    const scaffoldFlat = flatBuildExports(ctx, bridge);
    const entryRef = lookupEntryRef(modules, mode);
    const { exportsByKey, entryMemory } = await loadModules(modules, scaffoldFlat, entryRef);
    const entry = resolveEntry(modules, exportsByKey, mode);
    setCtxFromEntry(ctx, entry, entryMemory);
    const fn = entry.exports[entry.exportName];
    if (typeof fn !== 'function') {
      throw new Error(`entry export ${JSON.stringify(entry.exportName)} not callable`);
    }
    // The build imports may suspend (async Reader), so drive the entry through
    // `promising` and await it, mirroring `run`.
    const packed = await promising(fn as () => bigint)();
    const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
    const len = Number(packed & 0xFFFFFFFFn);
    return readSlice(ctx, ptr, len);
  }
}
