export interface InitialMessage {
  sigBuf: SharedArrayBuffer;
}

export interface JobMessage {
  code: Uint8Array;

  // TODO: Send getter values as optimizations
  // // These are just sent as optimizations; they're the same as what the driver would return if asked.
  // contractHash: Uint8Array;
  // params: Uint8Array;
  // body?: Uint8Array; // If this is set, we're running a contract/verifier. If not, it's a generator.
  // emitCorrect: boolean;

  // getterCache: {
  //   getContractHash?: Uint8Array;
  //   getParams?: Uint8Array;
  //   getBody?: Uint8Array;
  //   emitCorrect?: boolean;
  // };
}

export interface JsMessage {
  type: 'js';
  script: string;
  verifier: { contractHash: Uint8Array; params: Uint8Array }; // Can't just use Verifier since Hash isn't transferrable
  attemptCorrect: boolean;
}

export interface WorkerComm {
  ready(): undefined;
  exit(err?: any): undefined;

  getContractHash(offset: number, dstBufs: Uint8Array[]): Promise<number>;
  getParams(offset: number, dstBufs: Uint8Array[]): Promise<number>;
  getHint(offset: number, dstBufs: Uint8Array[]): Promise<number>;
  getBody(offset: number, dstBufs: Uint8Array[]): Promise<number>;
  emitCorrect(): Promise<number>;

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

  debugLog(msg: Uint8Array): undefined;
  debugPtr(name: Uint8Array, mem: Uint8Array, ptr: number): undefined;
  debugBreak(): Promise<void>;

  // notify(contractHash: Uint8Array, params: Uint8Array): undefined;
  // request(
  //   contractHash: Uint8Array,
  //   params: Uint8Array,
  //   result: Uint8Array,
  // ): Promise<number>;
  // result(data: Uint8Array): undefined;
}
