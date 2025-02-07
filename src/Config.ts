import { Context } from './Context.ts';
import { Verifier } from './messages.ts';
import { Resource } from './WorkerDriverService.ts';
import * as log from '@std/log';
import { secp } from './util/secp.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { NetworkProvider } from './NetworkProvider.ts';
import { ExecutionProvider } from './ExecutionProvider.ts';
import { ContractProvider } from './SpecialContractManager.ts';
import { makeDefaultContractProviders } from './contracts/defaultContractProviders.ts';
import { IngestionProvider, ReceptionProvider } from './IngestionProvider.ts';
import { defaultIngestionProviders } from './ingestors/defaultIngestionProviders.ts';
import { FrontierContract } from './contracts/FrontierContract.ts';
import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { LogEvent, LogLevel } from './Logger.ts';
import { ConsoleLoggingProvider } from '../plugins/ConsoleLoggingProvider.ts';
import { Fact, FactType } from './FactMeta.ts';

// TODO: Reorder, rename, reorganize config

export enum LogSystem {
  Main = 'main',
  Block = 'block',
  Connection = 'connection',
  Signaler = 'signaler',
}

export interface LoggingProvider {
  handler(event: LogEvent): void;
}

export interface GraphParameters {
  enforceTimestampMonotonicity: boolean;
  minimumGenerationTime: bigint;
  minimumCollateral(work: bigint, time: number): bigint;
}

export interface BackgroundJobParameters {
  frontierMergeIntervalMs: number;
}

export interface TestParameters {}

export interface TimeProvider {
  now(): number;
  setImmediate(cb: () => void): void;
  setTimeout(cb: () => void, delayMs: number): number;
  clearTimeout(idx: number): void;
  setInterval(cb: () => void, delayMs: number): number;
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
}

// You can modify the Config by mutating ctx.config
export interface Config {
  network: string;

  debugName: string;
  userdata?: string;
  selfPrivateKey: Uint8Array;
  clientNonce: string;

  logLevel: log.LogLevel;

  logLevels: { [key in LogSystem]?: LogLevel };

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

  workerPath?: string;

  loggingProviders: LoggingProvider[];
  timeProvider: TimeProvider;
  entropyProvider: EntropyProvider;
  storageProvider: StorageProvider;
  networkProviders: NetworkProvider[];
  executionProviders: ExecutionProvider[];
  // TODO: Split into generation and verification providers
  contractProviders: ContractProvider[];

  // Unlike the other providers, these will be managed (created and destroyed) by scaffold.
  // Pass arguments by binding to the class constructor.
  ingestionProviders: {
    new (context: Context): IngestionProvider<FactType> | ReceptionProvider<FactType>;
  }[];

  // appraisalProvider: AppraisalProvider;

  approxComputePricePerSecond: bigint; // TODO: I don't think we need this, just getGenerationReward.

  getDepositIncentive(verifier: Verifier): bigint;
  getGenerationReward(verifier: Verifier, computeTimeMs: number): bigint;
  getWeightLimit(factAgeMs: number): bigint;
  getNextWeightBreakpoint(weight: bigint): bigint;
  getOverpaymentPenalty(overpayment: bigint): bigint;

  bandwidthReciprocationBaseFactor: number;
  bandwidthReciprocationUtilityFactor: number;

  // requiredProfitPerComputeRatio: number;

  discardFutureBlocks: boolean;

  // Start forgetting facts when there's too many.
  targetFactCount: number;

  // Only use this for tests; it'll simply throw an error when we try to ingest one too many facts.
  limitFactCount: number;

  initialWorkerCount: number;

  maxShutdownTimeMs: number;

  baselineConnSendRate: number; // In units of bytes/ms/connection. Note that this is a baseline - recieving helpful blocks will increase this for that connection.

  resourceLimits: Record<Resource, number>;

  workScoreThreshold: number; // TODO: Units?

  selfIncentiveMultiplier: number; // How much more we should prioritize our own requests vs others' requests.

  graphParameters: GraphParameters;
  backgroundJobParameters: BackgroundJobParameters;
  testParameters: TestParameters;

  dbgVerifyGenerations: boolean;

  // enableBlockIngestion: boolean;
  enableValidation: boolean;
  enableWorkerLogging: boolean;
  enableSignalingLogging: boolean;

  enableFrontierVote: boolean;
  enableBlockThroughput: boolean;
  enableCollateralization: boolean;
  enableTreeAggregation: boolean;
  enableOptimisticHandling: boolean; // Don't validate blocks before returning them
}

export const defaultNetwork = 'main';
const rngSeed = 123n;

export const makeDefaultConfig = () => {
  const config = {
    network: defaultNetwork,
    debugName: '',
    clientNonce: Math.random().toString(36).slice(2),
    logLevel: log.LogLevels.INFO, // TODO: Set this to WARN
    logLevels: {
      [LogSystem.Main]: LogLevel.DEBUG,
      [LogSystem.Block]: LogLevel.DEBUG,
      [LogSystem.Connection]: LogLevel.DEBUG,
      [LogSystem.Signaler]: LogLevel.DEBUG,
    },
    loggingProviders: [new ConsoleLoggingProvider()],
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
      randomBytes: secp.etc.randomBytes,
    },
    executionProviders: [],
    contractProviders: makeDefaultContractProviders(),
    ingestionProviders: defaultIngestionProviders,
    approxComputePricePerSecond: 1000n,
    getDepositIncentive: (_verifier) => 10n,
    getGenerationReward: (_verifier, computeTimeMs) => BigInt(computeTimeMs * 0) + 5n,
    // getWeightLimit: (factAgeMs) => BigInt(factAgeMs),
    getWeightLimit: (_factAgeMs) => 1000000000n,
    getNextWeightBreakpoint: (weight) => weight <= 2n ? 3n : (weight * 3n) >> 1n,
    getOverpaymentPenalty: (overpayment) => overpayment,
    bandwidthReciprocationBaseFactor: 1,
    bandwidthReciprocationUtilityFactor: 1,
    discardFutureBlocks: false,
    // targetFactCount: 1000,
    targetFactCount: Infinity,
    // limitFactCount: Infinity,
    limitFactCount: 10000,
    initialWorkerCount: 16,
    maxShutdownTimeMs: 10000,
    baselineConnSendRate: 10, // 1 = 1kb / second
    resourceLimits: {
      webWorkerCount: 16,
      cpuUsage: navigator.hardwareConcurrency,
      memoryMb: 1024,
    },
    workScoreThreshold: 10,
    selfIncentiveMultiplier: 1.5,
    graphParameters: {
      enforceTimestampMonotonicity: false,
      minimumGenerationTime: 1n,
      minimumCollateral: (work, _time) => work * 1000n,
    },
    backgroundJobParameters: {
      frontierMergeIntervalMs: Infinity,
    },
    testParameters: {},
    dbgVerifyGenerations: false,
    enableValidation: true,
    enableWorkerLogging: true,
    enableSignalingLogging: true,

    enableFrontierVote: true,
    enableBlockThroughput: true,
    enableCollateralization: false,
    enableTreeAggregation: true,
    enableOptimisticHandling: false,
  } satisfies Partial<Config>;

  if (!config.enableBlockThroughput) {
    config.getDepositIncentive = () => 0n;
    config.getGenerationReward = () => 0n;
  }
  if (!config.enableTreeAggregation) {
    config.contractProviders = config.contractProviders.filter((x) =>
      !(x instanceof FrontierContract)
    );
  }

  return config;
};
