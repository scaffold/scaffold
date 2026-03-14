export type Timeout = ReturnType<typeof globalThis.setTimeout>;

export interface TimeProvider {
  now(): number;
  setImmediate(cb: () => void): void;
  setTimeout(cb: () => void, delayMs: number): Timeout;
  clearTimeout(idx: Timeout): void;
  setInterval(cb: () => void, delayMs: number): Timeout;
  clearInterval(idx: Timeout): void;
}
