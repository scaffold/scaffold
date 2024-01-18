import { Verifier } from './messages.ts';
import { Resource } from './WorkerDriverService.ts';
import { log } from '../deps.ts';
import secp from './util/secp.ts';
import Hash from './util/Hash.ts';
import { MaybePromise } from './util/types.ts';
import NetworkProvider from './NetworkProvider.ts';
import ExecutionProvider from './ExecutionProvider.ts';
import { ContractProvider } from './SpecialContractManager.ts';
import { defaultContractProviders } from './contracts/defaultContractProviders.ts';

// TODO: Reorder, rename, reorganize config

export interface GraphParameters {
  minimumCollateral(work: bigint, time: number): bigint;
}

export interface BackgroundJobParameters {
  frontierMergeIntervalMs?: number;
}

export interface TestParameters {
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
  list(namespace: number): AsyncIterable<{ key: Hash; value: Uint8Array }>;
  close(): MaybePromise<void>;
}

// You can modify the Config by mutating ctx.config
interface Config {
  network: string;

  debugName: string;
  userdata?: string;
  selfPrivateKey: Uint8Array;

  logLevel: log.LogLevel;

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
  // TODO: Split into generation and verification providers
  contractProviders: ContractProvider[];

  // appraisalProvider: AppraisalProvider;

  approxComputePricePerSecond: bigint; // TODO: I don't think we need this, just getGenerationReward.

  getGenerationReward(verifier: Verifier, computeTimeSeconds: number): bigint;
  getDepositIncentive(verifier: Verifier): bigint;

  // requiredProfitPerComputeRatio: number;

  // Only use this for tests; it'll simply throw an error when we try to ingest one too many facts.
  limitFactCount: number;

  // Only use this for tests; it allows frontier outputs to be specified on block specs. This can easily make emitted blocks invalid.
  allowSpecifiedFrontierOutputs: boolean;

  initialWorkerCount: number;

  maxShutdownTimeMs: number;

  onlyBridge?: boolean;

  resourceLimits: Record<Resource, number>;

  workScoreThreshold: number; // TODO: Units?

  selfIncentiveMultiplier: number; // How much more we should prioritize our own requests vs others' requests.

  graphParameters: GraphParameters;
  backgroundJobParameters: BackgroundJobParameters;
  testParameters: TestParameters;

  dbgVerifyGenerations: boolean;

  enableValidation: boolean;

  enableWorkerLogging: boolean;
}

export const defaultNetwork = 'main';

export const makeDefaultConfig = () => ({
  network: defaultNetwork,
  debugName: '',
  logLevel: log.LogLevels.INFO, // TODO: Set this to LogLevels.Warning
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
  contractProviders: defaultContractProviders,
  approxComputePricePerSecond: 1000n,
  getGenerationReward: (_verifier, computeTimeSeconds) =>
    BigInt(computeTimeSeconds * 1e6) + 1000n,
  getDepositIncentive: (_verifier) => 1n,
  // limitFactCount: Infinity,
  limitFactCount: 100,
  allowSpecifiedFrontierOutputs: false,
  initialWorkerCount: 16,
  maxShutdownTimeMs: 10000,
  resourceLimits: {
    webWorkerCount: 16,
    cpuUsage: navigator.hardwareConcurrency,
    memoryMb: 1024,
  },
  workScoreThreshold: 10,
  selfIncentiveMultiplier: 1.5,
  graphParameters: {
    minimumCollateral: (work, _time) => work * 1000n,
  },
  backgroundJobParameters: {},
  testParameters: {},
  dbgVerifyGenerations: false,
  enableValidation: true,
  enableWorkerLogging: true,
} satisfies Partial<Config>);

export default Config;
