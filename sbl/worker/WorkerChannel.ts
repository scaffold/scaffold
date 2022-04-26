export class WorkerChannelClient<T> {
  constructor(
    private port: Pick<Window, 'postMessage' | 'onmessage'>,
    private sigBuf: SharedArrayBuffer,
  ) {
    if (this.sigBuf.byteLength !== 8) {
      throw new Error('Unexpected worker signalling buffer');
    }
  }

  public inform<K extends keyof T>(
    func: K,
    args: T[K] extends (...args: any[]) => undefined
      ? ((...args: any[]) => undefined) extends T[K] ? Parameters<T[K]>
      : [never]
      : [never],
    transfer: Transferable[],
  ): void {
    this.port.postMessage({ func, args }, '/', transfer);
  }

  public dispatch<K extends keyof T>(
    func: K,
    args: T[K] extends (...args: any[]) => Promise<number>
      ? ((...args: any[]) => Promise<number>) extends T[K] ? Parameters<T[K]>
      : [never]
      : [never],
    transfer: Transferable[],
  ): number {
    const arr = new Int32Array(this.sigBuf);

    Atomics.store(arr, 0, 0);
    this.port.postMessage({ func, args }, '/', transfer);
    Atomics.wait(arr, 0, 0);

    return Atomics.load(arr, 1);
  }
}

export class WorkerChannelServer<T> {
  constructor(
    private port: Worker,
    private sigBuf: SharedArrayBuffer,
    private impl: T,
  ) {
    if (this.sigBuf.byteLength !== 8) {
      throw new Error('Unexpected worker signalling buffer');
    }

    this.port.onmessage = <K extends keyof T>(
      { data: { func, args } }: {
        data: {
          func: K;
          args: T[K] extends (...args: any[]) => any ? Parameters<T[K]> : never;
        };
      },
    ) =>
      (impl[func] as any)(...args)?.then((res: number) => {
        const arr = new Int32Array(this.sigBuf);
        Atomics.store(arr, 1, res);
        Atomics.store(arr, 0, 1);
        Atomics.notify(arr, 0, 1);
      }).catch((err: Error) =>
        console.error(`Error handling WorkerChannel request:`, err)
      );
  }
}
