import { assert } from './functional.ts';

export const arrRemove = <T>(arr: T[], value: T) => {
  const idx = arr.indexOf(value);
  assert(idx !== -1);
  arr.splice(idx, 1);
};

export const arrCall = <Args extends unknown[]>(
  arr: Iterable<(...args: Args) => void>,
  ...args: Args
) => {
  for (const cb of arr) {
    try {
      cb(...args);
    } catch (err) {
      // Subscriber error must not affect other subscribers or the append
      // TODO: Better error handling (maybe pass in a logger instance)
      console.error(err);
    }
  }
};
