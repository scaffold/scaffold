import { MaybePromise } from '../src/util/MaybePromise.ts';

export function isUnshared(data: Uint8Array): data is Uint8Array<ArrayBuffer> {
  return typeof SharedArrayBuffer === 'undefined' || !(data.buffer instanceof SharedArrayBuffer);
}

export function orderSignals(fn: (signal: string) => MaybePromise<void>) {
  const dispatchers: (() => MaybePromise<void>)[] = [];
  let isLocked = false;
  let nextSignalIdx = 0;

  return async (signal: string, idx: number) => {
    dispatchers[idx] ??= () => fn(signal);
    if (!isLocked) {
      isLocked = true;
      while (dispatchers[nextSignalIdx]) {
        await dispatchers[nextSignalIdx++]();
      }
      isLocked = false;
    }
  };
}
