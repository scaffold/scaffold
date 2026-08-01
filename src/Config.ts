import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { ContractPlugin } from './contract/Contract.ts';
import { DefaultContractProvider } from './contract/DefaultContractProvider.ts';
import { generateGenesis } from './graph/genesis.ts';
import { Hash } from './util/Hash.ts';
import { bin2hex } from './util/hex.ts';
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

  // Fee carried by the aggregation output every block we build attaches (wp 7)
  aggregationFee: bigint;

  timeProvider: TimeProvider;
  entropyProvider: EntropyProvider;
  contractProvider: ContractPlugin;
}

const rngSeed = 123n;

export const makeDefaultConfig = () => {
  const privateKeys = ['alice', 'bob', 'charlie'].map((name) =>
    Hash.digest(`scaffold:testnet:${name}`).toBytes()
  );

  const funding = Object.fromEntries(
    privateKeys.map((key) => [bin2hex(secp.getPublicKey(key, true)), 1_000_000n]),
  );

  const genesis = generateGenesis('default', funding);

  for (const [publicKey, amount] of Object.entries(funding)) {
    console.warn(`Genesis output: ${publicKey} has ${amount}`);
  }
  console.warn(`Genesis block hash: ${Hash.digest(genesis).toHex()}`);

  const config = {
    genesis,
    debugName: '',
    selfPrivateKey: privateKeys[0],
    aggregationFee: 0n,
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
  } satisfies Config;

  return config;
};
