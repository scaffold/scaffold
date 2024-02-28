import { MaybePromise } from '../src/util/MaybePromise.ts';

export const orderSignals = (fn: (signal: string) => MaybePromise<void>) => {
  const waiters: (() => MaybePromise<void>)[] = [];
  let isLocked = false;
  let nextSignalIdx = 0;

  return async (signal: string, idx: number) => {
    waiters[idx] = () => fn(signal);
    if (!isLocked) {
      isLocked = true;
      while (waiters[nextSignalIdx]) {
        await waiters[nextSignalIdx++]();
      }
      isLocked = false;
    }
  };
};
