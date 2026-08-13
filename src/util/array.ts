import { Logger } from '../interfaces/LoggingProvider.ts';
import { assert } from './functional.ts';

export const arrRemove = <T>(arr: T[], value: T) => {
  const idx = arr.indexOf(value);
  assert(idx !== -1);
  arr.splice(idx, 1);
};

// A throwing listener must not stop the fan-out or fail the notifying call,
// so pass a logger wherever one is in reach -- otherwise the throw is lost.
export const arrCall = <Args extends unknown[]>(
  arr: Iterable<(...args: Args) => void>,
  args: Args,
  log?: Logger,
) => {
  for (const cb of arr) {
    try {
      cb(...args);
    } catch (err) {
      log?.error('listenerFailed', { err });
    }
  }
};
