import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { ContractPlugin, ContractProvider } from './core/Contract.ts';
import { DefaultContractProvider } from './DefaultContractProvider.ts';
import { generateGenesis } from './genesis.ts';
import { Hash } from './util/Hash.ts';
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

// You can modify the Config by mutating ctx.config
export interface Config {
  genesis: Uint8Array;
  debugName: string;

  selfPrivateKey: Uint8Array;

  timeProvider: TimeProvider;
  entropyProvider: EntropyProvider;
  contractProvider: ContractPlugin;
}

const rngSeed = 123n;

export const makeDefaultConfig = () => {
  const privateKeys = {
    [Hash.digest('scaffold:testnet:alice').toHex()]: 1_000_000n,
    [Hash.digest('scaffold:testnet:bob').toHex()]: 1_000_000n,
    [Hash.digest('scaffold:testnet:charlie').toHex()]: 1_000_000n,
  };

  const genesis = generateGenesis('default', privateKeys);

  for (const [privateKey, amount] of Object.entries(privateKeys)) {
    console.warn(`Genesis output: ${privateKey} has ${amount}`);
  }
  console.warn(`Genesis block hash: ${Hash.digest(genesis).toHex()}`);

  const config = {
    genesis,
    debugName: '',
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
    contractProvider: DefaultContractProvider,
  } satisfies Partial<Config>;

  return config;
};
