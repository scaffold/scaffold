import Peer from './Peer.ts';
import Hash from './util/Hash.ts';
import Context from './Context.ts';
import NetworkProvider from './NetworkProvider.ts';

type Config = {
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

  trustedPeers: Peer[];

  selfPrivateKey: Uint8Array;
  nodeNonce: Uint8Array;

  approxComputePricePerSecond: bigint;
};

export default Config;
