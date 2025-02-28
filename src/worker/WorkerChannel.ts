import { assert } from '@std/assert/assert';
import { error } from '../util/functional.ts';
import { mapPut } from '../util/map.ts';

export const INTERRUPT_FLAG = Symbol('WorkerChannel.Interrupt');

const FLAG_WAIT = 0;
const FLAG_CONTINUE = 1;
const FLAG_THROW = 2;

export interface WorkerChannel<Spec> {
  inform<K extends keyof Spec>(
    func: K,
    args: Spec[K] extends (...args: any[]) => undefined
      ? ((...args: any[]) => undefined) extends Spec[K] ? Parameters<Spec[K]>
      : [never]
      : [never],
    transfer: Transferable[],
  ): void;

  dispatch<K extends keyof Spec>(
    func: K,
    args: Spec[K] extends (...args: any[]) => Promise<number>
      ? ((...args: any[]) => Promise<number>) extends Spec[K] ? Parameters<Spec[K]>
      : [never]
      : [never],
    transfer: Transferable[],
  ): number;
}

// Runs in the worker
export class WorkerChannelClient<Spec> {
  constructor(private port: Window, private sigBuf: SharedArrayBuffer) {
    if (this.sigBuf.byteLength !== 8) {
      throw new Error('Unexpected worker signalling buffer');
    }
  }

  createChannel(cid: number): WorkerChannel<Spec> {
    return {
      inform: (func, args, transfer) => {
        this.port.postMessage({ cid, func, args }, { transfer });
      },

      dispatch: (func, args, transfer) => {
        const arr = new Int32Array(this.sigBuf);

        Atomics.store(arr, 0, FLAG_WAIT);
        this.port.postMessage({ cid, func, args }, { transfer });
        console.log('WAIT...', func, args);
        Atomics.wait(arr, 0, FLAG_WAIT);
        if (Atomics.load(arr, 0) === FLAG_THROW) {
          throw INTERRUPT_FLAG;
        }
        console.log('CONTINUE...', func, args, Atomics.load(arr, 1));

        return Atomics.load(arr, 1);
      },
    };
  }
}

// Runs in the main task
export class WorkerChannelServer<T> {
  private channels = new Map<number, T>();

  constructor(port: Worker, sigBuf: SharedArrayBuffer) {
    if (sigBuf.byteLength !== 8) {
      throw new Error('Unexpected worker signalling buffer');
    }

    port.onmessage = <K extends keyof T>({ data: { cid, func, args } }: {
      data: {
        cid: number;
        func: K;
        args: T[K] extends (...args: any[]) => any ? Parameters<T[K]> : never;
      };
    }) => {
      const handler = this.channels.get(cid) ??
        error(`Unhandled message ${func.toString()}: ${args}`);

      (handler[func] as any)(...args)?.then((res: number) => {
        const arr = new Int32Array(sigBuf);
        Atomics.store(arr, 1, res);
        Atomics.store(arr, 0, FLAG_CONTINUE);
        Atomics.notify(arr, 0, 1);
      }, (err: unknown) => {
        console.error(`Error handling WorkerChannel request:`, err);
        const arr = new Int32Array(sigBuf);
        Atomics.store(arr, 0, FLAG_THROW);
        Atomics.notify(arr, 0, 1);
      });
    };
  }

  createChannel(cid: number, handler: T) {
    mapPut(this.channels, cid, () => handler, () => error(`Cannot create duplicate channels!`));
  }

  closeChannel(cid: number) {
    const deleted = this.channels.delete(cid);
    assert(deleted);
  }
}
