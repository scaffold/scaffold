export const INTERRUPT_FLAG = Symbol('WorkerChannel.Interrupt');

const FLAG_WAIT = 0;
const FLAG_CONTINUE = 1;
const FLAG_THROW = 2;

// Runs in the worker
export class WorkerChannelClient<T> {
  constructor(
    private port: Window,
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
    this.port.postMessage({ func, args }, { transfer });
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

    Atomics.store(arr, 0, FLAG_WAIT);
    this.port.postMessage({ func, args }, { transfer });
    console.log('WAIT...', func, args);
    Atomics.wait(arr, 0, FLAG_WAIT);
    if (Atomics.load(arr, 0) === FLAG_THROW) {
      throw INTERRUPT_FLAG;
    }
    console.log('CONTINUE...', func, args, Atomics.load(arr, 1));

    return Atomics.load(arr, 1);
  }
}

// Runs in the main task
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
        Atomics.store(arr, 0, FLAG_CONTINUE);
        Atomics.notify(arr, 0, 1);
      }, (err: Error | typeof INTERRUPT_FLAG) => {
        if (err === INTERRUPT_FLAG) {
          const arr = new Int32Array(this.sigBuf);
          Atomics.store(arr, 0, FLAG_THROW);
          Atomics.notify(arr, 0, 1);
        } else {
          console.error(`Error handling WorkerChannel request:`, err);
        }
      });
  }
}
