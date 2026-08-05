// The wire between the main thread and a WASM worker: a 16-byte signal SAB
// the worker Atomics.waits on, a staging SAB replies cross through, and
// structured-clone messages for everything asynchronous. Both sides import
// this file; nothing here touches an env or a transport.

import { error } from '../../util/functional.ts';
import { ValueKind } from './WasmTransport.ts';

export const SIG_FLAG = 0;
export const SIG_LEN = 1;
export const SIG_BUF_BYTES = 16;

export const FLAG_WAIT = 0;
export const FLAG_CONTINUE = 1;
export const FLAG_THROW = 2;

export interface ImportDecl {
  namespace: string;
  name: string;
  params: ValueKind[];
  result: ValueKind;
  blocking: boolean;
}

export type MainToWorker =
  | { type: 'init'; sigBuf: SharedArrayBuffer; stagingBuf: SharedArrayBuffer }
  | {
    type: 'exec';
    module: WebAssembly.Module;
    entry: string;
    decls: ImportDecl[];
    arg?: Uint8Array;
  }
  | { type: 'exit' };

export type WorkerToMain =
  | { type: 'call'; namespace: string; name: string; args: unknown[] }
  | { type: 'inform'; namespace: string; name: string; args: unknown[] }
  | { type: 'done'; result?: Uint8Array }
  | { type: 'crash'; message: string };

/** An import round-trips through the signal buffer iff the guest needs its
 * result or completion; pure void sinks are fire-and-forget. */
export const roundTrips = (decl: { blocking: boolean; result: ValueKind }): boolean =>
  decl.blocking || decl.result !== 'void';

export function encodeReply(kind: ValueKind, value: unknown): Uint8Array {
  switch (kind) {
    case 'void':
      return new Uint8Array();
    case 'bytes':
      return value as Uint8Array;
    case 'str':
      return new TextEncoder().encode(value as string);
    case 'i32': {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setInt32(0, value as number, true);
      return bytes;
    }
    case 'i64': {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, value as bigint, true);
      return bytes;
    }
    case 'f64': {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value as number, true);
      return bytes;
    }
  }
}

export function decodeReply(kind: ValueKind, payload: Uint8Array): unknown {
  const view = () => new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  switch (kind) {
    case 'void':
      return undefined;
    case 'bytes':
      return payload;
    case 'str':
      return new TextDecoder().decode(payload);
    case 'i32':
      return view().getInt32(0, true);
    case 'i64':
      return view().getBigInt64(0, true);
    case 'f64':
      return view().getFloat64(0, true);
    default:
      error(`unknown reply kind ${kind}`);
  }
}
