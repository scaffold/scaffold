import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { Context } from './Context.ts';
import { ContractProvider } from './contract/ContractProvider.ts';
import { DefaultContractProvider } from './contract/DefaultContractProvider.ts';
import { makeDefaultGenesis } from './genesis.ts';
import { LoggingProvider } from './interfaces/LoggingProvider.ts';
import { secp } from './util/secp.ts';

export type Timeout = ReturnType<typeof globalThis.setTimeout>;
export interface TimeProvider {
  nowMs(): number;
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

export interface ContractPlugin {
  new (ctx: Context): ContractProvider;
}

// Ambient environment only: no sensible default, and every context needs it.
// Per-module tuning lives in a config class next to its module, defaulted there
// and overridden via ctx.configure().
// You can modify the Config by mutating ctx.config
export interface Config {
  genesis: Uint8Array;
  debugName: string;

  selfPrivateKey: Uint8Array;

  timeProvider: TimeProvider;
  entropyProvider: EntropyProvider;
  contractPlugin: ContractPlugin;

  // Undefined disables logging outright: ctx.logger() then returns undefined
  // for every subsystem and no call site pays to build a message.
  loggingProvider?: LoggingProvider;
}

const rngSeed = 123n;

export function makeDefaultConfig(): Config {
  const { genesis, privateKeys } = makeDefaultGenesis();
  return {
    genesis,
    debugName: '',
    selfPrivateKey: privateKeys[0],
    timeProvider: {
      nowMs: () => Date.now(),
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
    contractPlugin: DefaultContractProvider,
  };
}
