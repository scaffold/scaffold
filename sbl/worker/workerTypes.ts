import { Script } from '../scriptTypes.ts';
import { Verifier } from '../messages.ts';

export interface InitialMessage {
  sigBuf: SharedArrayBuffer;
}

export interface JobMessage {
  code: Uint8Array;
  inputs: Record<string, Uint8Array>;
  outputSpec: Record<string, null>;
}

export interface JsMessage {
  type: 'js';
  script: string;
  verifier: Verifier;
  attemptCorrect: boolean;
}

export interface WorkerComm {
  ready(): undefined;
  exit(): undefined;

  // fsRoot(name: string, inode: number): undefined;
  // fsOpen(baseInode: number, key: Uint8Array, subInode: number): undefined;
  // // fsClose(inode: number): undefined;
  // fsRead(inode: number, offset: number, dstBufs: Uint8Array[]): Promise<number>;
  // // fsWrite(
  // //   inode: number,
  // //   offset: number,
  // //   bufs: Uint8Array[],
  // // ): Promise<number>; // TODO: Should this block?
  // fsGetSize(inode: number): Promise<number>;

  outputChunk(key: string, offset: number, data: Uint8Array): undefined;

  // New methods:
  // open(parentHdl: number, key: Uint8Array, childHdl: number): undefined;
  // read(hdl: number, offset: number, dstBufs: Uint8Array[]): Promise<number>;
  // size(hdl: number): Promise<number>;
  // write(hdl: number, offset: number, bufs: Uint8Array[]): undefined;

  // This doesn't support a way to read multiple blocks with the same verifier
  init(type: string, inode: number): undefined;
  open(
    baseInode: number,
    params: Uint8Array,
    amount: bigint,
    subInode: number,
  ): undefined;
  read(inode: number, offset: number, dstBufs: Uint8Array[]): Promise<number>;
  getSize(inode: number): Promise<number>;

  // notify(contractHash: Uint8Array, params: Uint8Array): undefined;
  // request(
  //   contractHash: Uint8Array,
  //   params: Uint8Array,
  //   result: Uint8Array,
  // ): Promise<number>;
  // result(data: Uint8Array): undefined;
}
