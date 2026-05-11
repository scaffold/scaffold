// Protocol spec: docs/protocol/wasm-abi.md#optional-jspi
//
// Same-thread WASM execution where async host imports suspend the WASM
// stack via `WebAssembly.Suspending` and the entry export is wrapped with
// `WebAssembly.promising`. Supports stacking
// ([wasm-abi.md#stacking](docs/protocol/wasm-abi.md#stacking)): all layers
// share one `env.memory`, only the bottom layer sees scaffold exports.
//
// Available in Chrome 137+ (and behind a flag elsewhere); detect with
// `JspiTransport.isSupported()` before constructing.

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
import { buildImportsForLayer, type CompiledStack, presentExports } from '../WasmLayers.ts';

// JSPI types (TC39 stage-4; not yet in TS lib). Declared minimally.
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

// -- Memory + helpers ---------------------------------------------

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
  if (!jspi.Suspending) {
    throw new Error('JSPI not supported in this runtime');
  }
  return new jspi.Suspending(fn);
}

function promising<Fn extends (...args: never[]) => unknown>(
  fn: Fn,
): (...args: Parameters<Fn>) => Promise<ReturnType<Fn>> {
  if (!jspi.promising) {
    throw new Error('JSPI not supported in this runtime');
  }
  return jspi.promising(fn);
}

function makeSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 4096, shared: true });
}

// -- Flat scaffold export builders --------------------------------

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

// -- Stack instantiation ------------------------------------------

interface LoadedStack {
  ctx: InstanceCtx;
  topExports: Record<string, unknown>;
}

async function loadStack(
  stack: CompiledStack,
  scaffoldFlat: Record<string, unknown>,
  ctx: InstanceCtx,
  memory: WebAssembly.Memory,
): Promise<LoadedStack> {
  if (stack.layers.length === 0) {
    throw new Error('CompiledStack.layers must be non-empty');
  }
  let presentedLower: Record<string, unknown> = scaffoldFlat;
  let topExports: Record<string, unknown> | null = null;
  for (const entry of stack.layers) {
    const imports = buildImportsForLayer(entry.module, entry.mapImports, presentedLower, memory);
    const instance = await WebAssembly.instantiate(entry.module, imports);
    const exports = instance.exports as Record<string, unknown>;
    presentedLower = presentExports(exports, entry.mapExports);
    topExports = exports;
  }
  const alloc = topExports!.alloc;
  if (typeof alloc !== 'function') {
    throw new Error('top WASM module is missing required `alloc` export');
  }
  ctx.memory = memory;
  ctx.alloc = alloc as (size: number) => number;
  return { ctx, topExports: topExports! };
}

// -- Transport ----------------------------------------------------

export class JspiTransport implements WasmTransport {
  static isSupported(): boolean {
    return typeof jspi.Suspending === 'function' && typeof jspi.promising === 'function';
  }

  constructor() {
    if (!JspiTransport.isSupported()) {
      throw new Error('JSPI is not supported in this runtime');
    }
  }

  async run(stack: CompiledStack, env: ContractEnv): Promise<void> {
    const ctx = makeEmptyCtx();
    const memory = makeSharedMemory();
    const bridge = makeRunBridge(env);
    const scaffoldFlat = flatRunExports(ctx, bridge);
    const loaded = await loadStack(stack, scaffoldFlat, ctx, memory);
    const runFn = loaded.topExports.run;
    if (typeof runFn !== 'function') {
      throw new Error('top WASM module is missing required `run` export');
    }
    const promisingRun = promising(runFn as () => unknown);
    try {
      await promisingRun();
    } catch (err) {
      if (err instanceof ContractRejection) throw err;
      throw err;
    }
  }

  async walkParams(
    stack: CompiledStack,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    await this.runWalk(stack, 'walk_params', params, host);
  }

  async walkData(
    stack: CompiledStack,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    await this.runWalk(stack, 'walk_data', data, host);
  }

  async buildParams(stack: CompiledStack, host: BuilderHost): Promise<Uint8Array> {
    return await this.runBuild(stack, 'build_params', host);
  }

  async buildData(stack: CompiledStack, host: BuilderHost): Promise<Uint8Array> {
    return await this.runBuild(stack, 'build_data', host);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async runWalk(
    stack: CompiledStack,
    exportName: 'walk_params' | 'walk_data',
    bytes: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    const ctx = makeEmptyCtx();
    const memory = makeSharedMemory();
    const bridge = makeWalkBridge(host);
    const scaffoldFlat = flatWalkExports(ctx, bridge);
    const loaded = await loadStack(stack, scaffoldFlat, ctx, memory);
    const fn = loaded.topExports[exportName];
    if (typeof fn !== 'function') {
      throw new Error(`top WASM module is missing required \`${exportName}\` export`);
    }
    const ptr = allocAndWrite(ctx, bytes);
    (fn as (p: number, l: number) => void)(ptr, bytes.length);
  }

  private async runBuild(
    stack: CompiledStack,
    exportName: 'build_params' | 'build_data',
    host: BuilderHost,
  ): Promise<Uint8Array> {
    const ctx = makeEmptyCtx();
    const memory = makeSharedMemory();
    const bridge = makeBuildBridge(host);
    const scaffoldFlat = flatBuildExports(ctx, bridge);
    const loaded = await loadStack(stack, scaffoldFlat, ctx, memory);
    const fn = loaded.topExports[exportName];
    if (typeof fn !== 'function') {
      throw new Error(`top WASM module is missing required \`${exportName}\` export`);
    }
    const packed = (fn as () => bigint)();
    const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
    const len = Number(packed & 0xFFFFFFFFn);
    return readSlice(ctx, ptr, len);
  }
}
