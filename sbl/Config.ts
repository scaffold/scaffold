import Peer from './Peer.ts';
import Hash from './util/Hash.ts';
import Context from './Context.ts';
import NetworkProvider from './NetworkProvider.ts';
import { Verifier } from './messages.ts';
import { Resource } from './ExecutorDriverService.ts';
// import AppraisalProvider from './AppraisalProvider.ts';

// TODO: Reorder, rename, reorganize config

interface GraphParameters {
  multiplyDataCollateral(x: bigint, time: number): bigint;
}

interface TimeProvider {
  now(): number;
  setTimeout(cb: () => void, delay: number): number;
  clearTimeout(idx: number): void;
  setInterval(cb: () => void, delay: number): number;
  clearInterval(idx: number): void;
}

interface Config {
  debugName: string;

  // To disable logging, unset the entire "log" object.
  log: undefined | {
    handler: (
      ctx: Context,
      className: string,
      methodName: string,
      params: Record<string, any>,
    ) => void;
  };

  location: { x: number; y: number; z: number };

  // initialPublicMetadata: {
  //   name: string;
  //   implName: string;
  //   protocolVersion: number;
  //   agePtr: string;
  // };

  // trustVec: Map<string, number>;

  // forwardingFee: number;
  // peerJudgementCollateral: number;

  shouldVerify(ctx: Context, fromPeer: Peer, pub: any): boolean;

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

  trustedPeers: Peer[];

  selfPrivateKey: Uint8Array;
  nodeNonce: Uint8Array;

  approxComputePricePerSecond: bigint; // TODO: I don't think we need this, just getGenerationReward.

  getGenerationReward(verifier: Verifier, computeTimeSeconds: number): bigint;
  getDepositIncentive(verifier: Verifier): bigint;

  // requiredProfitPerComputeRatio: number;

  initialWorkerCount: number;

  onlyBridge?: boolean;

  computeContracts: Hash[];

  timeProvider: TimeProvider;

  resourceLimits: Record<Resource, number>;

  workScoreThreshold: number; // TODO: Units?

  graphParameters: GraphParameters;
}

export const defaultConfig = {
  getGenerationReward: (_verifier, computeTimeSeconds) =>
    BigInt(computeTimeSeconds * 1e6) + 1000n,
  getDepositIncentive: (_verifier) => 1n,
  timeProvider: {
    now: Date.now,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
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
} satisfies Partial<Config>;

export default Config;
