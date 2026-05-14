// Protocol spec: docs/protocol/wasm-abi.md#async-bridge-transport
//
// Atomics + SAB bridge purpose-built for the WASM contract ABI. Distinct from
// `src/worker/WorkerChannel.ts` (which backs the legacy JS-contract path);
// the legacy channel returns only i32 results, while the WASM ABI needs
// byte returns plus a reject-vs-crash distinction. Keeping them as siblings
// avoids destabilising the legacy callers.
//
// Signal buffer layout (16 bytes, 4 x i32):
//   [SIG_FLAG] FLAG: WAIT | CONTINUE | THROW_REJECT | THROW_CRASH
//   [SIG_LEN]  bytes written to staging (also doubles as numeric result)
//   [2]        reserved
//   [3]        reserved
//
// Staging buffer (default 64 KiB): byte returns + reject reason strings.
// v1 caps at single-shot -- results larger than the staging buffer surface
// as CRASH. Ring-buffered chunking is a follow-up (see plan sectionRisks).

import { ContractRejection } from '../../core/ContractEnv.ts';

export const SIG_BUF_SIZE = 16;
export const STAGING_DEFAULT_SIZE = 64 * 1024;

const SIG_FLAG = 0;
const SIG_LEN = 1;

const FLAG_WAIT = 0;
const FLAG_CONTINUE = 1;
const FLAG_THROW_REJECT = 2;
const FLAG_THROW_CRASH = 3;

/** Error a worker raises when the host signals THROW_REJECT. */
export class WasmRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmRejectError';
  }
}

/** Error a worker raises when the host signals THROW_CRASH or anything unexpected. */
export class WasmCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WasmCrashError';
  }
}

interface MessagePort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

// -- Client (runs in worker) -------------------------------------

/**
 * Worker-side dispatcher. Posts messages to the main thread and (for
 * `dispatchBytes`) blocks on the signal buffer until the result lands in
 * the staging buffer.
 */
export class WasmWorkerChannelClient {
  private readonly sigArr: Int32Array;

  constructor(
    private readonly port: MessagePort,
    private readonly sigBuf: SharedArrayBuffer,
    private readonly stagingBuf: SharedArrayBuffer,
  ) {
    if (sigBuf.byteLength < SIG_BUF_SIZE) {
      throw new Error(`signal buffer too small: ${sigBuf.byteLength} < ${SIG_BUF_SIZE}`);
    }
    this.sigArr = new Int32Array(sigBuf);
  }

  /** Fire-and-forget. Used for void-returning imports (emit_output, sign, etc.). */
  inform(func: string, args: unknown[]): void {
    this.port.postMessage({ type: 'host_inform', func, args });
  }

  /**
   * Synchronous-from-WASM-perspective bytes round trip. The main thread
   * fulfils the call, writes bytes into the staging buffer, and signals.
   * Returns a freshly-allocated `Uint8Array` so callers may keep it past
   * the next dispatch.
   *
   * Throws `WasmRejectError` if the host signalled a contract rejection,
   * `WasmCrashError` for anything else.
   */
  dispatchBytes(func: string, args: unknown[]): Uint8Array {
    Atomics.store(this.sigArr, SIG_FLAG, FLAG_WAIT);
    this.port.postMessage({ type: 'host_dispatch', func, args });
    Atomics.wait(this.sigArr, SIG_FLAG, FLAG_WAIT);
    const flag = Atomics.load(this.sigArr, SIG_FLAG);
    const len = Atomics.load(this.sigArr, SIG_LEN);
    if (flag === FLAG_CONTINUE) {
      if (len < 0 || len > this.stagingBuf.byteLength) {
        throw new WasmCrashError(`invalid staging length: ${len}`);
      }
      return new Uint8Array(this.stagingBuf, 0, len).slice();
    }
    if (flag === FLAG_THROW_REJECT) {
      const reason = new TextDecoder().decode(
        new Uint8Array(this.stagingBuf, 0, Math.min(len, this.stagingBuf.byteLength)),
      );
      throw new WasmRejectError(reason);
    }
    throw new WasmCrashError(`host dispatch failed (flag=${flag})`);
  }

  /** Void-returning dispatch (used for `put`, which blocks until commit). */
  dispatchVoid(func: string, args: unknown[]): void {
    this.dispatchBytes(func, args);
  }

  stagingByteLength(): number {
    return this.stagingBuf.byteLength;
  }
}

// -- Server (runs on main thread) --------------------------------

/** Handler returns either bytes or void; thrown ContractRejection becomes THROW_REJECT. */
export interface WasmHostHandler {
  (args: unknown[]): Promise<Uint8Array | void> | Uint8Array | void;
}

export interface WasmHostHandlers {
  [func: string]: WasmHostHandler;
}

/**
 * Main-thread server. Routes worker `host_inform` / `host_dispatch` messages
 * to handler functions, writes byte results into the staging buffer, and
 * signals back via Atomics.
 */
export class WasmWorkerChannelServer {
  private readonly sigArr: Int32Array;
  private handlers: WasmHostHandlers | null = null;
  /** External listener for terminal worker messages (done/reject/crash). */
  private terminalListener: ((msg: unknown) => void) | null = null;

  constructor(
    private readonly worker: Worker,
    private readonly sigBuf: SharedArrayBuffer,
    private readonly stagingBuf: SharedArrayBuffer,
  ) {
    if (sigBuf.byteLength < SIG_BUF_SIZE) {
      throw new Error(`signal buffer too small: ${sigBuf.byteLength} < ${SIG_BUF_SIZE}`);
    }
    this.sigArr = new Int32Array(sigBuf);
    worker.onmessage = (ev) => this.handleMessage(ev.data);
  }

  setHandlers(handlers: WasmHostHandlers): void {
    this.handlers = handlers;
  }

  onTerminal(listener: (msg: unknown) => void): void {
    this.terminalListener = listener;
  }

  stagingByteLength(): number {
    return this.stagingBuf.byteLength;
  }

  private signal(flag: number, len: number): void {
    Atomics.store(this.sigArr, SIG_LEN, len);
    Atomics.store(this.sigArr, SIG_FLAG, flag);
    Atomics.notify(this.sigArr, SIG_FLAG, 1);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) return;
    const m = msg as { type: string };
    if (m.type === 'host_inform') {
      await this.runInform(msg as unknown as { func: string; args: unknown[] });
      return;
    }
    if (m.type === 'host_dispatch') {
      await this.runDispatch(msg as unknown as { func: string; args: unknown[] });
      return;
    }
    if (m.type === 'done' || m.type === 'reject' || m.type === 'crash') {
      this.terminalListener?.(msg);
      return;
    }
  }

  private async runInform(msg: { func: string; args: unknown[] }): Promise<void> {
    const handler = this.handlers?.[msg.func];
    if (!handler) {
      // Drop with a log -- inform calls have no caller waiting to be notified.
      // The terminal `crash` reporting catches genuine bugs.
      console.warn(`wasm host: unknown inform '${msg.func}'`);
      return;
    }
    try {
      await handler(msg.args);
    } catch (err) {
      console.error(`wasm host: inform '${msg.func}' threw`, err);
    }
  }

  private async runDispatch(msg: { func: string; args: unknown[] }): Promise<void> {
    const handler = this.handlers?.[msg.func];
    if (!handler) {
      this.signal(FLAG_THROW_CRASH, 0);
      return;
    }
    try {
      const result = await handler(msg.args);
      const bytes = result instanceof Uint8Array ? result : new Uint8Array(0);
      if (bytes.length > this.stagingBuf.byteLength) {
        // v1 cap: oversize result is a crash.
        this.signal(FLAG_THROW_CRASH, 0);
        return;
      }
      new Uint8Array(this.stagingBuf, 0, bytes.length).set(bytes);
      this.signal(FLAG_CONTINUE, bytes.length);
    } catch (err) {
      if (err instanceof ContractRejection) {
        const reason = new TextEncoder().encode(err.message);
        const len = Math.min(reason.length, this.stagingBuf.byteLength);
        new Uint8Array(this.stagingBuf, 0, len).set(reason.subarray(0, len));
        this.signal(FLAG_THROW_REJECT, len);
        return;
      }
      console.error(`wasm host: dispatch '${msg.func}' crashed`, err);
      this.signal(FLAG_THROW_CRASH, 0);
    }
  }
}

// Constants exported for tests + transport implementations.
export const Flags = {
  WAIT: FLAG_WAIT,
  CONTINUE: FLAG_CONTINUE,
  THROW_REJECT: FLAG_THROW_REJECT,
  THROW_CRASH: FLAG_THROW_CRASH,
};
