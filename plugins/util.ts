import { MaybePromise } from '../src/util/MaybePromise.ts';

const HEX_RE = /^[0-9a-f]{16,}$/i;

/** Abbreviate hex hashes in log data so a console line stays readable. */
export function shortenHashes(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(data)) result[key] = shortenValue(data[key]);
  return result;
}

function shortenValue(val: unknown): unknown {
  if (typeof val === 'string' && HEX_RE.test(val)) return val.slice(0, 8) + '..';
  if (Array.isArray(val)) return val.map(shortenValue);
  if (val && typeof val === 'object') return shortenHashes(val as Record<string, unknown>);
  return val;
}

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
