import { Context } from './Context.ts';
import { error } from './util/functional.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';

export interface WorkerDebugger {
  log(msg: Uint8Array): void;
  ptr(name: Uint8Array, mem: Uint8Array, ptr: number): void;
  // Once we're paused inside brk(), we can attach another WASM instance to our memory and read/modify our ptr.
  // Modifying the C++ code of our attached WASM should automatically and immediately re-compile and re-attach.
  brk(): Promise<void>;
}

// Other debugging ideas:
//   Replace this wasm (based on hash) with another wasm, or even a JS function.
//   Allow mutation of requests/replies.
//   Allow mutation of previous requests/replies (which will rollback and rerun).

export class WorkerDebuggerManager {
  private dbgrs = new Map<HashPrimitive, WorkerDebugger>();

  constructor(private ctx: Context) {}

  public setDebugger(wasmHash: Hash, dbgr: WorkerDebugger | undefined) {
    if (dbgr !== undefined) {
      this.dbgrs.set(wasmHash.toPrimitive(), dbgr);
    } else {
      this.dbgrs.delete(wasmHash.toPrimitive());
    }
  }

  public getDebugger(wasmHash: Hash) {
    return this.dbgrs.get(wasmHash.toPrimitive()) ??
      error(`No debugger configured for ${wasmHash.toHex()}`);
  }
}
