// Protocol spec: docs/protocol/wasm-abi.md
//
// Worker-side instance: composes host imports backed by `WasmWorkerChannel`
// and runs the configured export. Mirrors the in-process transport's
// import-composition logic but reads/writes the result bytes via the
// channel's staging buffer + Atomics.wait instead of directly invoking
// the env on the main thread.

import {
  WasmCrashError,
  WasmRejectError,
  type WasmWorkerChannelClient,
} from './WasmWorkerChannel.ts';
import type { WasmCallMsg, WasmInstantiateMsg, WasmSessionMode } from './wasmWorkerTypes.ts';

const SCAFFOLD_TRAP_TAG = '__scaffold_reject__:';

/** Packed (ptr, len) helper. */
function packPtrLen(ptr: number, len: number): bigint {
  return (BigInt(ptr >>> 0) << 32n) | BigInt(len >>> 0);
}

interface SessionCtx {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
}

function readSlice(ctx: SessionCtx, ptr: number, len: number): Uint8Array {
  return new Uint8Array(ctx.memory.buffer, ptr, len).slice();
}

function readString(ctx: SessionCtx, ptr: number, len: number): string {
  return new TextDecoder().decode(readSlice(ctx, ptr, len));
}

function allocAndWrite(ctx: SessionCtx, bytes: Uint8Array): number {
  const ptr = ctx.alloc(bytes.length);
  new Uint8Array(ctx.memory.buffer, ptr, bytes.length).set(bytes);
  return ptr;
}

/**
 * Wrap a dispatchBytes call so it returns a packed (ptr, len) usable by the
 * contract: the host-supplied bytes get allocated in contract memory.
 */
function dispatchPacked(
  ctx: SessionCtx,
  client: WasmWorkerChannelClient,
  func: string,
  args: unknown[],
): bigint {
  const bytes = client.dispatchBytes(func, args);
  const ptr = allocAndWrite(ctx, bytes);
  return packPtrLen(ptr, bytes.length);
}

// -- run-mode imports ---------------------------------------------

interface RunPreset {
  executionMode: number;
  contractHash: Uint8Array;
  params: Uint8Array;
  timestamp: bigint;
}

function makeRunImports(
  ctx: SessionCtx,
  client: WasmWorkerChannelClient,
  preset: RunPreset,
): WebAssembly.Imports {
  return {
    scaffold_env: {
      mode: () => preset.executionMode,
      contract_hash: () =>
        packPtrLen(allocAndWrite(ctx, preset.contractHash), preset.contractHash.length),
      contract_metadata: (vp: number, vl: number) =>
        dispatchPacked(ctx, client, 'contract_metadata', [readSlice(ctx, vp, vl)]),
      params: () => packPtrLen(allocAndWrite(ctx, preset.params), preset.params.length),
      timestamp: () => preset.timestamp,
      claim_next: () => dispatchPacked(ctx, client, 'claim_next', []),
      claim_all: (limit: number) => dispatchPacked(ctx, client, 'claim_all', [limit]),
      emit_output: (op: number, ol: number) => {
        // Use dispatchVoid so a host-side throw surfaces as a trap rather
        // than being lost: emit_output may legitimately fail validation
        // (e.g. namespace violation) and we need that to abort the contract.
        client.dispatchVoid('emit_output', [readSlice(ctx, op, ol)]);
      },
      request_body: (vp: number, vl: number) =>
        dispatchPacked(ctx, client, 'request_body', [readSlice(ctx, vp, vl)]),
      fetch: (vp: number, vl: number, kp: number, kl: number) =>
        dispatchPacked(ctx, client, 'fetch', [readSlice(ctx, vp, vl), readSlice(ctx, kp, kl)]),
      fork: (vp: number, vl: number, rp: number, rl: number) => {
        client.dispatchVoid('fork', [readSlice(ctx, vp, vl), readSlice(ctx, rp, rl)]);
      },
      sign: (pp: number, pl: number) => {
        client.dispatchVoid('sign', [readSlice(ctx, pp, pl)]);
      },
      reject: (rp: number, rl: number) => {
        // Local trap -- the runtime catches this on the main thread and
        // re-throws as ContractRejection. No round trip needed.
        throw new WasmRejectError(readString(ctx, rp, rl));
      },
    },
  };
}

// -- walk-mode imports --------------------------------------------

function makeWalkImports(
  ctx: SessionCtx,
  client: WasmWorkerChannelClient,
): WebAssembly.Imports {
  return {
    scaffold_walker: {
      emit_bytes: (kp: number, kl: number, vp: number, vl: number, dp: number, dl: number) => {
        client.inform('emit_bytes', [
          readString(ctx, kp, kl),
          readSlice(ctx, vp, vl),
          readSlice(ctx, dp, dl),
        ]);
      },
      emit_string: (kp: number, kl: number, vp: number, vl: number, dp: number, dl: number) => {
        client.inform('emit_string', [
          readString(ctx, kp, kl),
          readString(ctx, vp, vl),
          readSlice(ctx, dp, dl),
        ]);
      },
      emit_number: (kp: number, kl: number, value: number, dp: number, dl: number) => {
        client.inform('emit_number', [readString(ctx, kp, kl), value, readSlice(ctx, dp, dl)]);
      },
      emit_bool: (kp: number, kl: number, value: number, dp: number, dl: number) => {
        client.inform('emit_bool', [readString(ctx, kp, kl), value !== 0, readSlice(ctx, dp, dl)]);
      },
      emit_map_start: (kp: number, kl: number) => {
        const reply = client.dispatchBytes('emit_map_start', [readString(ctx, kp, kl)]);
        return reply.length > 0 && reply[0] !== 0 ? 1 : 0;
      },
      emit_map_end: () => {
        client.inform('emit_map_end', []);
      },
      emit_list_start: (kp: number, kl: number, count: number) => {
        const reply = client.dispatchBytes('emit_list_start', [readString(ctx, kp, kl), count]);
        return reply.length > 0 && reply[0] !== 0 ? 1 : 0;
      },
      emit_list_end: () => {
        client.inform('emit_list_end', []);
      },
    },
  };
}

// -- build-mode imports -------------------------------------------

function makeBuildImports(
  ctx: SessionCtx,
  client: WasmWorkerChannelClient,
): WebAssembly.Imports {
  return {
    scaffold_builder: {
      request_bytes: (kp: number, kl: number, dp: number, dl: number) =>
        dispatchPacked(ctx, client, 'request_bytes', [
          readString(ctx, kp, kl),
          readSlice(ctx, dp, dl),
        ]),
      request_string: (kp: number, kl: number, dp: number, dl: number) =>
        dispatchPacked(ctx, client, 'request_string', [
          readString(ctx, kp, kl),
          readSlice(ctx, dp, dl),
        ]),
      request_number: (kp: number, kl: number, dp: number, dl: number) => {
        const reply = client.dispatchBytes('request_number', [
          readString(ctx, kp, kl),
          readSlice(ctx, dp, dl),
        ]);
        if (reply.length !== 8) throw new WasmCrashError('request_number reply must be 8 bytes');
        return new DataView(reply.buffer, reply.byteOffset, 8).getFloat64(0, true);
      },
      request_bool: (kp: number, kl: number, dp: number, dl: number) => {
        const reply = client.dispatchBytes('request_bool', [
          readString(ctx, kp, kl),
          readSlice(ctx, dp, dl),
        ]);
        return reply.length > 0 && reply[0] !== 0 ? 1 : 0;
      },
      request_array_length: (kp: number, kl: number, dp: number, dl: number) => {
        const reply = client.dispatchBytes('request_array_length', [
          readString(ctx, kp, kl),
          readSlice(ctx, dp, dl),
        ]);
        if (reply.length !== 4) {
          throw new WasmCrashError('request_array_length reply must be 4 bytes');
        }
        return new DataView(reply.buffer, reply.byteOffset, 4).getInt32(0, true);
      },
      begin_object: (kp: number, kl: number) => {
        client.inform('begin_object', [readString(ctx, kp, kl)]);
      },
      end_object: () => {
        client.inform('end_object', []);
      },
      begin_array: (kp: number, kl: number) => {
        client.inform('begin_array', [readString(ctx, kp, kl)]);
      },
      end_array: () => {
        client.inform('end_array', []);
      },
      validation_error: (kp: number, kl: number, mp: number, ml: number) => {
        client.inform('validation_error', [readString(ctx, kp, kl), readString(ctx, mp, ml)]);
      },
    },
  };
}

// -- Session ------------------------------------------------------

function makeEmptyCtx(): SessionCtx {
  return {
    memory: null as unknown as WebAssembly.Memory,
    alloc: () => {
      throw new Error('alloc called before instantiation');
    },
  };
}

interface InstantiateResult {
  ctx: SessionCtx;
  exports: Record<string, unknown>;
  mode: WasmSessionMode;
}

export class WasmSession {
  private instantiated: InstantiateResult | null = null;

  constructor(private readonly client: WasmWorkerChannelClient) {}

  async instantiate(msg: WasmInstantiateMsg): Promise<void> {
    const ctx: SessionCtx = makeEmptyCtx();
    let imports: WebAssembly.Imports;
    if (msg.mode === 'run') {
      if (!msg.preset) throw new Error('run mode requires preset');
      imports = makeRunImports(ctx, this.client, msg.preset);
    } else if (msg.mode === 'walk_params' || msg.mode === 'walk_data') {
      imports = makeWalkImports(ctx, this.client);
    } else {
      imports = makeBuildImports(ctx, this.client);
    }

    const instance = await WebAssembly.instantiate(msg.module, imports);
    const exports = instance.exports as Record<string, unknown>;
    const alloc = exports.alloc;
    if (typeof alloc !== 'function') {
      throw new Error('contract module is missing required `alloc` export');
    }
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error('contract module must export `memory`');
    }
    ctx.memory = memory;
    ctx.alloc = alloc as (size: number) => number;
    this.instantiated = { ctx, exports, mode: msg.mode };
  }

  call(msg: WasmCallMsg): Uint8Array | undefined {
    if (!this.instantiated) throw new Error('not instantiated');
    const { ctx, exports, mode } = this.instantiated;

    if (mode === 'run') {
      const fn = exports.run;
      if (typeof fn !== 'function') throw new Error('missing `run` export');
      (fn as () => void)();
      return undefined;
    }
    if (mode === 'walk_params' || mode === 'walk_data') {
      const fn = exports[mode];
      if (typeof fn !== 'function') throw new Error(`missing \`${mode}\` export`);
      const input = msg.input ?? new Uint8Array(0);
      const ptr = allocAndWrite(ctx, input);
      (fn as (p: number, l: number) => void)(ptr, input.length);
      return undefined;
    }
    // build_params / build_data
    const fn = exports[mode];
    if (typeof fn !== 'function') throw new Error(`missing \`${mode}\` export`);
    const packed = (fn as () => bigint)();
    const ptr = Number((packed >> 32n) & 0xFFFFFFFFn);
    const len = Number(packed & 0xFFFFFFFFn);
    return readSlice(ctx, ptr, len);
  }
}

export { SCAFFOLD_TRAP_TAG };
