import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { secp } from './util/secp.ts';

export enum LogSystem {
  Main = 'main',
  Fact = 'fact',
  Connection = 'connection',
  Signaler = 'signaler',
  Worker = 'worker',
  Verification = 'verification',
  Generation = 'generation',
  Constraint = 'constraint',
  SnapshotState = 'snapshot_state',
  SnapshotDiff = 'snapshot_diff',
}

export type Timeout = ReturnType<typeof globalThis.setTimeout>;
export interface TimeProvider {
  now(): number;
  setImmediate(cb: () => void): void;
  setTimeout(cb: () => void, delayMs: number): Timeout;
  clearTimeout(idx: Timeout): void;
  setInterval(cb: () => void, delayMs: number): Timeout;
  clearInterval(idx: Timeout): void;
}

export interface EntropyProvider {
  randomNumber(): number;
  cryptoRandomBytes(size: number): Uint8Array;
}

// You can modify the Config by mutating ctx.config
export interface Config {
  network: string;
  debugName: string;

  selfPrivateKey: Uint8Array;

  timeProvider: TimeProvider;
  entropyProvider: EntropyProvider;
}

export const defaultNetwork = 'main';
const rngSeed = 123n;

export const makeDefaultConfig = () => {
  const config = {
    network: defaultNetwork,
    debugName: '',
    timeProvider: {
      now: () => Date.now(),
      setImmediate: (cb) => setTimeout(cb, 0),
      setTimeout: (cb, delayMs) => setTimeout(cb, delayMs),
      clearTimeout: (idx) => clearTimeout(idx),
      setInterval: (cb, delayMs) => setInterval(cb, delayMs),
      clearInterval: (idx) => clearInterval(idx),
    },
    entropyProvider: rngSeed !== undefined ? new SeededEntropyProvider(rngSeed) : {
      randomNumber: () => Math.random(),
      cryptoRandomBytes: secp.etc.randomBytes,
    },
  } satisfies Partial<Config>;

  return config;
};
