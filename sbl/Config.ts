import NetworkProvider from './NetworkProvider.ts';
import { Verifier } from './messages.ts';
import { Resource } from './ExecutorDriverService.ts';
import * as log from 'std-latest/log/mod.ts';

// TODO: Reorder, rename, reorganize config

export interface GraphParameters {
  multiplyDataCollateral(x: bigint, time: number): bigint;
}

export interface TimeProvider {
  now(): number;
  setTimeout(cb: () => void, delay: number): number;
  clearTimeout(idx: number): void;
  setInterval(cb: () => void, delay: number): number;
  clearInterval(idx: number): void;
}

interface Config {
  network: string;

  debugName: string;
  userdata?: string;
  selfPrivateKey: Uint8Array;
  nodeNonce: Uint8Array;

  logLevel: log.LevelName;

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

  networkProvider: NetworkProvider;

  // appraisalProvider: AppraisalProvider;

  approxComputePricePerSecond: bigint; // TODO: I don't think we need this, just getGenerationReward.

  getGenerationReward(verifier: Verifier, computeTimeSeconds: number): bigint;
  getDepositIncentive(verifier: Verifier): bigint;

  // requiredProfitPerComputeRatio: number;

  initialWorkerCount: number;

  onlyBridge?: boolean;

  timeProvider: TimeProvider;

  resourceLimits: Record<Resource, number>;

  workScoreThreshold: number; // TODO: Units?

  graphParameters: GraphParameters;

  dbgVerifyGenerations: boolean;

  enableValidation: boolean;
}

export const defaultConfig = {
  network: 'main',
  logLevel: 'WARNING',
  approxComputePricePerSecond: 1000n,
  getGenerationReward: (_verifier, computeTimeSeconds) =>
    BigInt(computeTimeSeconds * 1e6) + 1000n,
  getDepositIncentive: (_verifier) => 1n,
  initialWorkerCount: 16,
  timeProvider: {
    now: Date.now.bind(Date),
    setTimeout: setTimeout.bind(window),
    clearTimeout: clearTimeout.bind(window),
    setInterval: setInterval.bind(window),
    clearInterval: clearInterval.bind(window),
  },
  resourceLimits: {
    webWorkerCount: 16,
    cpuUsage: navigator.hardwareConcurrency,
    memoryMb: 1024,
  },
  workScoreThreshold: 10,
  graphParameters: {
    multiplyDataCollateral: (x, _time) => {
      // const totalSupply = 1n << 60n;
      // TODO: Softmin with some fraction of the total supply
      return x * 2n;
    },
  },
  dbgVerifyGenerations: false,
  enableValidation: true,
} satisfies Partial<Config>;

export default Config;
