import { Verifier } from './messages.ts';
import { Resource } from './WorkerDriverService.ts';
import * as log from 'std-latest/log/mod.ts';
import secp from './util/secp.ts';
import Hash from '~/sbl/util/Hash.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import NetworkProvider from '~/sbl/NetworkProvider.ts';
import ExecutionProvider from '~/sbl/ExecutionProvider.ts';

// TODO: Reorder, rename, reorganize config

export interface TestParameters {
}

export interface GraphParameters {
  minimumCollateral(work: bigint, time: number): bigint;
}

export interface TimeProvider {
  now(): number;
  setImmediate(cb: () => void): void;
  setTimeout(cb: () => void, delay: number): number;
  clearTimeout(idx: number): void;
  setInterval(cb: () => void, delay: number): number;
  clearInterval(idx: number): void;
}

export interface EntropyProvider {
  randomNumber(): number;
  randomBytes(size: number): Uint8Array;
}

export interface StorageProvider {
  set(namespace: number, key: Hash, value?: Uint8Array): void;
  get(namespace: number, key: Hash): MaybePromise<Uint8Array | undefined>;
  list(namespace: number): AsyncIterator<{ key: Hash; value: Uint8Array }>;
  close(): MaybePromise<void>;
}

interface Config {
  network: string;

  debugName: string;
  userdata?: string;
  selfPrivateKey: Uint8Array;

  logLevel: log.LogLevels;

  // initialPublicMetadata: {
  //   name: string;
  //   implName: string;
  //   protocolVersion: number;
  //   agePtr: string;
  // };

  // trustVec: Map<string, number>;

  // forwardingFee: number;
  // peerJudgementCollateral: number;

  // contracts: {
  //   hash: Hash;
  //   func: (
  //     params: Uint8Array,
  //     answer: Uint8Array, // TODO: Maybe we don't give the answer here, but make the func request it?
  //     request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
  //   ) => boolean;
  // }[];

  // generators: {
  //   contractHash: Hash;
  //   isCorrect: boolean;
  //   func: (
  //     params: Uint8Array,
  //     request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
  //   ) => Uint8Array;

  //   emitTime?: (
  //     params: Uint8Array,
  //     request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
  //   ) => Uint8Array;
  // }[];

  timeProvider: TimeProvider;
  entropyProvider: EntropyProvider;
  storageProvider: StorageProvider;
  networkProviders: NetworkProvider[];
  executionProviders: ExecutionProvider[];

  // appraisalProvider: AppraisalProvider;

  approxComputePricePerSecond: bigint; // TODO: I don't think we need this, just getGenerationReward.

  getGenerationReward(verifier: Verifier, computeTimeSeconds: number): bigint;
  getDepositIncentive(verifier: Verifier): bigint;

  // requiredProfitPerComputeRatio: number;

  initialWorkerCount: number;

  maxShutdownTimeMs: number;

  onlyBridge?: boolean;

  resourceLimits: Record<Resource, number>;

  workScoreThreshold: number; // TODO: Units?

  graphParameters: GraphParameters;
  testParameters: TestParameters;

  dbgVerifyGenerations: boolean;

  enableValidation: boolean;

  enableWorkerLogging: boolean;
}

export const defaultConfig = {
  network: 'main',
  debugName: '',
  logLevel: log.LogLevels.WARNING,
  timeProvider: {
    now: Date.now.bind(Date),
    setImmediate: (cb) => setTimeout(cb, 0),
    setTimeout: setTimeout.bind(window),
    clearTimeout: clearTimeout.bind(window),
    setInterval: setInterval.bind(window),
    clearInterval: clearInterval.bind(window),
  },
  entropyProvider: {
    randomNumber: Math.random.bind(Math),
    randomBytes: secp.etc.randomBytes,
  },
  executionProviders: [],
  approxComputePricePerSecond: 1000n,
  getGenerationReward: (_verifier, computeTimeSeconds) =>
    BigInt(computeTimeSeconds * 1e6) + 1000n,
  getDepositIncentive: (_verifier) => 1n,
  initialWorkerCount: 16,
  maxShutdownTimeMs: 10000,
  resourceLimits: {
    webWorkerCount: 16,
    cpuUsage: navigator.hardwareConcurrency,
    memoryMb: 1024,
  },
  workScoreThreshold: 10,
  graphParameters: {
    minimumCollateral: (work, _time) => work * 1000n,
  },
  testParameters: {},
  dbgVerifyGenerations: false,
  enableValidation: true,
  enableWorkerLogging: true,
} satisfies Partial<Config>;

export default Config;
