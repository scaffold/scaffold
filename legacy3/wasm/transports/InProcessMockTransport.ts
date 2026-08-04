// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport
//
// Same-thread WASM execution. The transport supplies a shared linear
// memory, instantiates every module in the graph via `loadModules`, then
// invokes the entry export named by `base.imports[<mode>]`. Cross-edge
// references go through JS forwarders so cycles in the graph work.

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
  type CompiledModules,
  type ExportEntry,
  loadModules,
  syncExport,
  type TargetRef,
} from '../WasmModules.ts';

const SYNC_ONLY_ERROR = 'InProcessMockTransport: host import returned a Promise; ' +
  'switch to JspiTransport or AtomicsWorkerTransport for async execution';

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

function expectSync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error(SYNC_ONLY_ERROR);
  return value;
}

// -- Scaffold flat exports (keyed by bare name) ------------------------

/** Wrap every value in `syncExport(...)` -- InProcess imports are all sync. */
function asSyncEntries<T extends Record<string, (...args: never[]) => unknown>>(
  obj: T,
): Record<string, ExportEntry> {
  const out: Record<string, ExportEntry> = {};
  for (const [k, fn] of Object.entries(obj)) {
    out[k] = syncExport(fn as (...args: unknown[]) => unknown);
  }
  return out;
}

function flatRunExports(ctx: InstanceCtx, bridge: RunBridge): Record<string, ExportEntry> {
  const handlePackedBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return asSyncEntries({
    mode: () => bridge.mode(),
    contract_hash: () => handlePackedBytes(bridge.contractHash()),
    contract_metadata: (vp: number, vl: number) =>
      handlePackedBytes(expectSync(bridge.contractMetadata(readSlice(ctx, vp, vl)))),
    params: () => handlePackedBytes(bridge.params()),
    timestamp: () => bridge.timestamp(),
    claim_next: () => handlePackedBytes(expectSync(bridge.claimNext())),
    claim_all: (limit: number) => handlePackedBytes(expectSync(bridge.claimAll(limit))),
    emit_output: (op: number, ol: number) => {
      bridge.send(readSlice(ctx, op, ol));
    },
    request_body: (vp: number, vl: number) =>
      handlePackedBytes(expectSync(bridge.request(readSlice(ctx, vp, vl)))),
    fetch: (vp: number, vl: number, kp: number, kl: number) =>
      handlePackedBytes(
        expectSync(bridge.fetch(readSlice(ctx, vp, vl), readSlice(ctx, kp, kl))),
      ),
    put: (vp: number, vl: number, rp: number, rl: number) => {
      expectSync(bridge.put(readSlice(ctx, vp, vl), readSlice(ctx, rp, rl)));
    },
    sign: (pp: number, pl: number) => {
      bridge.sign(readSlice(ctx, pp, pl));
    },
    // /out/debug routing for the WASI shim. Diagnostic-only; never traps.
    debug: (rp: number, rl: number) => {
      bridge.debug(readSlice(ctx, rp, rl));
    },
    reject: (rp: number, rl: number) => {
      bridge.reject(readSlice(ctx, rp, rl));
    },
  });
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
  const handlePackedBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  // The build bridge is MaybePromise; this transport is synchronous, so every
  // call must resolve sync (an in-memory `Reader` does). `expectSync` throws on
  // a Promise, pointing the caller at the JSPI/Atomics transports.
  return asSyncEntries({
    request_bytes: (kp: number, kl: number, dp: number, dl: number) =>
      handlePackedBytes(
        expectSync(
          bridge.requestBytes(
            readString(ctx, kp, kl),
            parseValueDescriptor(readSlice(ctx, dp, dl)),
          ),
        ),
      ),
    request_string: (kp: number, kl: number, dp: number, dl: number) =>
      handlePackedBytes(
        expectSync(
          bridge.requestString(
            readString(ctx, kp, kl),
            parseValueDescriptor(readSlice(ctx, dp, dl)),
          ),
        ),
      ),
    request_number: (kp: number, kl: number, dp: number, dl: number) =>
      expectSync(
        bridge.requestNumber(readString(ctx, kp, kl), parseValueDescriptor(readSlice(ctx, dp, dl))),
      ),
    request_bool: (kp: number, kl: number, dp: number, dl: number) =>
      expectSync(
        bridge.requestBool(readString(ctx, kp, kl), parseValueDescriptor(readSlice(ctx, dp, dl))),
      ),
    request_array_length: (kp: number, kl: number, dp: number, dl: number) =>
      expectSync(
        bridge.requestArrayLength(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      ),
    request_value_type: (kp: number, kl: number, dp: number, dl: number) =>
      expectSync(
        bridge.requestValueType(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      ),
    request_object_keys: (kp: number, kl: number, dp: number, dl: number) =>
      handlePackedBytes(
        expectSync(
          bridge.requestObjectKeys(
            readString(ctx, kp, kl),
            parseValueDescriptor(readSlice(ctx, dp, dl)),
          ),
        ),
      ),
    begin_object: (kp: number, kl: number) =>
      expectSync(bridge.beginObject(readString(ctx, kp, kl))),
    end_object: () => bridge.endObject(),
    begin_array: (kp: number, kl: number) => expectSync(bridge.beginArray(readString(ctx, kp, kl))),
    end_array: () => bridge.endArray(),
    validation_error: (kp: number, kl: number, mp: number, ml: number) =>
      bridge.validationError(readString(ctx, kp, kl), readString(ctx, mp, ml)),
  });
}

// -- Entry resolution --------------------------------------------------

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
    throw new Error(
      `modules.base.imports[${JSON.stringify(mode)}]: layer ${
        JSON.stringify(ref.layerKey)
      } not found`,
    );
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

// -- Transport ---------------------------------------------------------

export class InProcessMockTransport implements WasmTransport {
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
      throw new Error(
        `entry layer ${JSON.stringify(entry.layerKey)} has no export ${
          JSON.stringify(entry.exportName)
        }`,
      );
    }
    try {
      (fn as () => void)();
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
      throw new Error(
        `entry layer ${JSON.stringify(entry.layerKey)} has no export ${
          JSON.stringify(entry.exportName)
        }`,
      );
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
      throw new Error(
        `entry layer ${JSON.stringify(entry.layerKey)} has no export ${
          JSON.stringify(entry.exportName)
        }`,
      );
    }
    const packed = (fn as () => bigint)();
    const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
    const len = Number(packed & 0xFFFFFFFFn);
    return readSlice(ctx, ptr, len);
  }
}
