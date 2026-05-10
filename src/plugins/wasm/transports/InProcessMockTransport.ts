// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport
//
// Same-thread WASM execution with no Worker, no SAB, no JSPI. Suitable for
// verification (where the env is fully sync) and for walker/builder paths
// (which are always sync). If a may-block import returns a Promise, this
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

const SYNC_ONLY_ERROR = 'InProcessMockTransport: host import returned a Promise; ' +
  'switch to JspiTransport or AtomicsWorkerTransport for async execution';

interface InstanceCtx {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
}

/** Pre-instantiation placeholder; filled in once `loadInstance` returns. */
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

/** Allocate `bytes` worth of room in contract memory and copy `bytes` in. */
function allocAndWrite(ctx: InstanceCtx, bytes: Uint8Array): number {
  const ptr = ctx.alloc(bytes.length);
  new Uint8Array(ctx.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

function expectSync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error(SYNC_ONLY_ERROR);
  return value;
}

// -- Imports composers --------------------------------------------

function makeRunImports(ctx: InstanceCtx, bridge: RunBridge): WebAssembly.Imports {
  const handlePackedBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    env: {},
    scaffold_env: {
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
    },
  };
}

function makeWalkImports(ctx: InstanceCtx, bridge: WalkBridge): WebAssembly.Imports {
  return {
    scaffold_walker: {
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
    },
  };
}

function makeBuildImports(ctx: InstanceCtx, bridge: BuildBridge): WebAssembly.Imports {
  const handlePackedBytes = (bytes: Uint8Array): bigint => {
    const ptr = allocAndWrite(ctx, bytes);
    return packPtrLen(ptr, bytes.length);
  };
  return {
    scaffold_builder: {
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
    },
  };
}

// -- Instance lifecycle -------------------------------------------

interface Loaded {
  ctx: InstanceCtx;
  exports: Record<string, unknown>;
}

async function loadInstance(
  module: WebAssembly.Module,
  imports: WebAssembly.Imports,
): Promise<Loaded> {
  const instance = await WebAssembly.instantiate(module, imports);
  const exports = instance.exports as Record<string, unknown>;
  const alloc = exports.alloc;
  if (typeof alloc !== 'function') {
    throw new Error('contract module is missing required `alloc` export');
  }
  const memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('contract module must export `memory`');
  }
  return {
    ctx: { memory, alloc: alloc as (size: number) => number },
    exports,
  };
}

// -- Transport ----------------------------------------------------

export class InProcessMockTransport implements WasmTransport {
  async run(module: WebAssembly.Module, env: ContractEnv): Promise<void> {
    const ctx: InstanceCtx = makeEmptyCtx();
    const bridge = makeRunBridge(env);
    const imports = makeRunImports(ctx, bridge);
    const loaded = await loadInstance(module, imports);
    Object.assign(ctx, loaded.ctx);
    const runFn = loaded.exports.run;
    if (typeof runFn !== 'function') {
      throw new Error('contract module is missing required `run` export');
    }
    try {
      (runFn as () => void)();
    } catch (err) {
      if (err instanceof ContractRejection) throw err;
      // WASM traps in Deno surface as RuntimeError with message containing
      // 'unreachable' for ContractRejection paths that didn't intercept.
      throw err;
    }
  }

  async walkParams(
    module: WebAssembly.Module,
    params: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    await this.runWalk(module, 'walk_params', params, host);
  }

  async walkData(
    module: WebAssembly.Module,
    data: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    await this.runWalk(module, 'walk_data', data, host);
  }

  async buildParams(module: WebAssembly.Module, host: BuilderHost): Promise<Uint8Array> {
    return await this.runBuild(module, 'build_params', host);
  }

  async buildData(module: WebAssembly.Module, host: BuilderHost): Promise<Uint8Array> {
    return await this.runBuild(module, 'build_data', host);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private async runWalk(
    module: WebAssembly.Module,
    exportName: 'walk_params' | 'walk_data',
    bytes: Uint8Array,
    host: WalkerHost,
  ): Promise<void> {
    const ctx: InstanceCtx = makeEmptyCtx();
    const bridge = makeWalkBridge(host);
    const imports = makeWalkImports(ctx, bridge);
    const loaded = await loadInstance(module, imports);
    Object.assign(ctx, loaded.ctx);
    const fn = loaded.exports[exportName];
    if (typeof fn !== 'function') {
      throw new Error(`contract module is missing optional \`${exportName}\` export`);
    }
    const ptr = allocAndWrite(ctx, bytes);
    (fn as (p: number, l: number) => void)(ptr, bytes.length);
  }

  private async runBuild(
    module: WebAssembly.Module,
    exportName: 'build_params' | 'build_data',
    host: BuilderHost,
  ): Promise<Uint8Array> {
    const ctx: InstanceCtx = makeEmptyCtx();
    const bridge = makeBuildBridge(host);
    const imports = makeBuildImports(ctx, bridge);
    const loaded = await loadInstance(module, imports);
    Object.assign(ctx, loaded.ctx);
    const fn = loaded.exports[exportName];
    if (typeof fn !== 'function') {
      throw new Error(`contract module is missing optional \`${exportName}\` export`);
    }
    const packed = (fn as () => bigint)();
    const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
    const len = Number(packed & 0xFFFFFFFFn);
    return readSlice(ctx, ptr, len);
  }
}
