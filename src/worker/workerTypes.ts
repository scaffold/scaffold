import { LogLevel } from '../Logger.ts';
import { BytesTree } from '../protocol/base.ts';

export interface InitialMsg {
  type: 'init';
  sigBuf: SharedArrayBuffer;
}
export interface InstantiateWasmMsg {
  type: 'instantiate_wasm';
  instanceId: number;
  module: WebAssembly.Module;
  // readMetas?: string[];

  // const wasmMagic = new Uint8Array([0, 0x61, 0x73, 0x6D]);
}
export interface CallMethodMsg {
  type: 'call_method';
  instanceId: number;
  method: string;
}
export interface ExitMsg {
  type: 'exit';
}
export type JobSpec = InitialMsg | InstantiateWasmMsg | CallMethodMsg | ExitMsg;

// Each of these roots have different fs-level permissions, which the worker should set up
export enum FsName {
  ContractHash = 0,
  Params,
  Hint,
  Body,
  EmitCorrect,
  Ext,
  Output,
  Log,
}

export interface WorkerComm {
  ready(): undefined;
  exit(err?: any): undefined;

  // readMetas(metas: { [key: string]: Uint8Array }): undefined;

  init(name: FsName, hdl: number): undefined;
  open(parentHdl: number, childHdl: number, key: Uint8Array): undefined;
  // TODO: Convert all the `dstBufs: Uint8Array[]` to `dstBuf: Uint8Array` if most of the time it's just one element.
  // We could also remove the getSize() method and make read() method return the TOTAL size, not just the written size.
  size(hdl: number): Promise<number>;
  read(hdl: number, offset: number, dstBufs: Uint8Array[]): Promise<number>;
  write(hdl: number, offset: number, srcBufs: Uint8Array[]): undefined;

  log(level: LogLevel, message: string, data: { [key: string]: unknown }): undefined;

  debugLog(msg: Uint8Array): undefined;
  debugPtr(name: Uint8Array, mem: Uint8Array, ptr: number): undefined;
  debugBreak(): Promise<void>;
}
