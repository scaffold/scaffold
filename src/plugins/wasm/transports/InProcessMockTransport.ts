// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport
//
// Same-thread WASM execution with no Worker, no SAB-dispatch, no JSPI.
// Supports stacking ([wasm-abi.md#stacking](docs/protocol/wasm-abi.md#stacking)):
// the transport supplies a runtime-owned shared linear memory under
// `env.memory`, instantiates each layer bottom-up with `buildImportsForLayer`,
// and routes host calls through `WasmHostBridge` -- only the bottom layer
// sees the scaffold export view.
//
// Suitable for verification (where the env is fully sync) and for walker /
// builder paths (also sync). If a may-block import returns a Promise, this
// transport throws with a clear message -- switch to JspiTransport or
// AtomicsWorkerTransport for async generation.

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
import { buildImportsForLayer, type CompiledStack } from '../WasmLayers.ts';

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

// -- Flat scaffold export builders -------------------------------------
// These return one big flat dict (no namespace) suitable as the bottom
// layer's `lowerExports` view in `buildImportsForLayer`.

function flatRunExports(ctx: InstanceCtx, bridge: RunBridge): Record<string, unknown> {
  const handlePackedBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    mode: () => bridge.mode(),
    contract_hash: () => handlePackedBytes(bridge.contractHash()),
    contract_metadata: (vp: number, vl: number) => {
      const verifier = readSlice(ctx, vp, vl);
      return handlePackedBytes(expectSync(bridge.contractMetadata(verifier)));
    },
    params: () => handlePackedBytes(bridge.params()),
    timestamp: () => bridge.timestamp(),
    claim_next: () => handlePackedBytes(expectSync(bridge.claimNext())),
    claim_all: (limit: number) => handlePackedBytes(expectSync(bridge.claimAll(limit))),
    emit_output: (op: number, ol: number) => {
      bridge.emitOutput(readSlice(ctx, op, ol));
    },
    request_body: (vp: number, vl: number) =>
      handlePackedBytes(expectSync(bridge.requestBody(readSlice(ctx, vp, vl)))),
    fetch: (vp: number, vl: number, kp: number, kl: number) =>
      handlePackedBytes(
        expectSync(bridge.fetch(readSlice(ctx, vp, vl), readSlice(ctx, kp, kl))),
      ),
    fork: (vp: number, vl: number, rp: number, rl: number) => {
      expectSync(bridge.fork(readSlice(ctx, vp, vl), readSlice(ctx, rp, rl)));
    },
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
  const handlePackedBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    request_bytes: (kp: number, kl: number, dp: number, dl: number) =>
      handlePackedBytes(
        bridge.requestBytes(
          readString(ctx, kp, kl),
          parseValueDescriptor(readSlice(ctx, dp, dl)),
        ),
      ),
    request_string: (kp: number, kl: number, dp: number, dl: number) =>
      handlePackedBytes(
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

// -- Stack instantiation -----------------------------------------------

/** Allocate the runtime-supplied shared memory used by every layer. */
function makeSharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 4096, shared: true });
}

interface LoadedStack {
  ctx: InstanceCtx;
  /** Top instance's exports (where `run`, `walk_*`, `build_*`, `alloc` live). */
  topExports: Record<string, unknown>;
}

async function loadStack(
  stack: CompiledStack,
  scaffoldFlat: Record<string, unknown>,
  ctx: InstanceCtx,
  memory: WebAssembly.Memory,
): Promise<LoadedStack> {
  // Walk the stack bottom-to-top, using each instance's exports as the
  // next layer's `lowerExports`.
  let lowerExports: Record<string, unknown> = scaffoldFlat;
  for (const entry of stack.layers) {
    const imports = buildImportsForLayer(entry.module, entry.mapImports, lowerExports, memory);
    const instance = await WebAssembly.instantiate(entry.module, imports);
    lowerExports = instance.exports as Record<string, unknown>;
  }
  // Primary (top) instance.
  const primaryImports = buildImportsForLayer(
    stack.primary.module,
    stack.primary.mapImports,
    lowerExports,
    memory,
  );
  const top = await WebAssembly.instantiate(stack.primary.module, primaryImports);
  const topExports = top.exports as Record<string, unknown>;
  const alloc = topExports.alloc;
  if (typeof alloc !== 'function') {
    throw new Error('top WASM module is missing required `alloc` export');
  }
  ctx.memory = memory;
  ctx.alloc = alloc as (size: number) => number;
  return { ctx, topExports };
}

// -- Transport ---------------------------------------------------------

export class InProcessMockTransport implements WasmTransport {
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
    try {
      (runFn as () => void)();
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
