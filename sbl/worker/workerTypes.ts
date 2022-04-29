import { Script } from '../scriptTypes.ts';

export interface InitialMessage {
  sigBuf: SharedArrayBuffer;
}

export interface JobMessage {
  script: Script;
  inputs: Record<string, Uint8Array>;
  outputSpec: Record<string, null>;
}

export interface WorkerComm {
  ready(): undefined;
  exit(): undefined;

  fsRoot(name: string, inode: number): undefined;
  fsOpen(baseInode: number, key: Uint8Array, subInode: number): undefined;
  // fsClose(inode: number): undefined;
  fsRead(inode: number, offset: number, dstBufs: Uint8Array[]): Promise<number>;
  // fsWrite(
  //   inode: number,
  //   offset: number,
  //   bufs: Uint8Array[],
  // ): Promise<number>; // TODO: Should this block?
  fsGetSize(inode: number): Promise<number>;

  outputChunk(key: string, offset: number, data: Uint8Array): undefined;

  // New methods:
  // open(parentHdl: number, key: Uint8Array, childHdl: number): undefined;
  // read(hdl: number, offset: number, dstBufs: Uint8Array[]): Promise<number>;
  // size(hdl: number): Promise<number>;
  // write(hdl: number, offset: number, bufs: Uint8Array[]): undefined;
}
