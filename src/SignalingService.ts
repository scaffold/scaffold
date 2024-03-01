import { ConnectionSignalFact, FactBase, FactType } from './FactMeta.ts';
import { Context } from './Context.ts';
import { ConnectionSignal, SignalPayload } from './messages.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { FactService } from './FactService.ts';
import { PeerManager } from './PeerManager.ts';
import { ClockService } from './ClockService.ts';
import { SignalingDriver, SignalingProvider } from './NetworkProvider.ts';
import { NetworkService } from './NetworkService.ts';
import { mapPut } from './util/map.ts';
import { assert } from './util/functional.ts';
import { bin2hex } from './util/hex.ts';
import { CryptoHelper } from './CryptoHelper.ts';
import { ConnectionService } from './ConnectionService.ts';
import { arrEquals, bin2prim } from './util/buffer.ts';
import { SignalingRecordSet } from './record_sets/SignalingRecordSet.ts';
import { KeyService } from './KeyService.ts';
import { FactSource } from './FactMeta.ts';

const closeTimeoutMs = 30000;

export interface SignalingState {
  remotePublicKey: Uint8Array;
  remoteClientNonce: string;
  localProtocol: string;

  nextEmitIdx: number;
  unackedPayloads: Map<number, Uint8Array>;

  receivedIdxMask: bigint;
  lastIngestTimestamp: number;

  closed: boolean;

  log?: { timestamp: number; message: string }[];
}

interface SignalingInstance extends SignalingState {
  provider: SignalingProvider;
}

export class SignalingService {
  private instances = new Map<string, SignalingInstance>();

  constructor(private ctx: Context) {
    // this.ctx.get(ClockService).setPoissonInterval(() => {
    //   const threshold = this.ctx.config.timeProvider.now() - closeTimeoutMs;
    //   for (const [key, state] of this.states) {
    //     if (state.lastIngestTimestamp < threshold) {
    //       state.provider.dispose?.();
    //       this.states.delete(key);
    //       this.ctx.maybeGet(SignalingRecordSet)?.dispatchRemove(state);
    //     }
    //   }
    // }, closeTimeoutMs);

    this.ctx.onDestruct(() => {
      for (const [_, state] of this.instances) {
        state.provider.dispose?.();
      }
    });
  }

  public getAllStates() {
    return this.instances.values();
  }

  public isConnecting(publicKey: Uint8Array, clientNonce: string) {
    for (const [_, state] of this.instances) {
      if (
        arrEquals(state.remotePublicKey, publicKey) &&
        state.remoteClientNonce === clientNonce
      ) {
        return true;
      }
    }
    return false;
  }

  public emit(state: SignalingState, payload: SignalPayload) {
    if (state.closed) {
      return;
    }

    // { name: 'srcClientNonce', type: 'string' },
    // { name: 'srcProtocol', type: 'string' },
    // { name: 'dstProtocol', type: 'string' },
    // { name: 'receivedIdxMask', type: 'bigint' },
    // { name: 'signalIdx', type: 'int' },
    // { name: 'signalData', type: 'string' },

    state.log?.push({
      timestamp: this.ctx.config.timeProvider.now(),
      message: `Sending signal ${payload.signalIdx}: ${payload.signalData}...`,
    });
    this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);

    this.ctx.get(CryptoHelper).encrypt({
      plaintext: SignalPayload.encode(payload),
      remotePublicKey: state.remotePublicKey,
    }).then((payload) => {
      const infoFact = this.ctx.get(PeerManager).getPeer(state.remotePublicKey)
        ?.clientInfoFacts.get(state.remoteClientNonce);

      if (infoFact !== undefined) {
        const signal = { replyTo: infoFact.hash, payload };
        this.ctx.get(FactService)
          .emit(signal, ConnectionSignal, FactType.ConnectionSignal, true);
      }
    }).then(() => {
      state.log?.push({
        timestamp: this.ctx.config.timeProvider.now(),
        message: `Sent!`,
      });
      this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);
    }, (err) => {
      state.log?.push({
        timestamp: this.ctx.config.timeProvider.now(),
        message: `Failed! ${err}`,
      });
      this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);
      console.error(err);
    });
  }

  public createFact(base: FactBase): ConnectionSignalFact {
    const signal = ConnectionSignal.decode(base.message);

    const fact: ConnectionSignalFact = Object.assign(
      base,
      signal,
      { type: FactType.ConnectionSignal as const },
    );

    const dstFact = this.ctx.get(FactService).get(signal.replyTo, false);
    if (dstFact !== undefined) {
      if (dstFact.source === FactSource.Local) {
        const remotePublicKey = this.ctx.get(FactService).getPublicKey(fact);
        this.ctx.get(CryptoHelper).decrypt({
          ciphertext: signal.payload,
          remotePublicKey,
        }).then((data) =>
          this.ingestSignal(remotePublicKey, SignalPayload.decode(data))
        ).catch((err) => console.error(err));
      } else {
        for (const conn of this.ctx.get(PeerManager).routeTo(dstFact)) {
          this.ctx.get(FactService).sendTo(fact, conn);
        }
      }
    }

    return fact;
  }

  public init(
    remotePublicKey: Uint8Array,
    remoteClientNonce: string,
    remoteProtocol: string,
  ) {
    const signalingNonce = Hash.random().toBytes();

    const instance = this.ctx.get(SignalingService).ingestSignal(
      remotePublicKey,
      {
        signalingNonce,
        srcClientNonce: remoteClientNonce,
        srcProtocol: remoteProtocol,
        receivedIdxMask: 0n,
        signalIdx: -1,
        signalData: '',
      },
    );

    if (instance.nextEmitIdx === 0) {
      this.emit(instance, {
        signalingNonce,
        srcClientNonce: this.ctx.config.clientNonce,
        srcProtocol: instance.localProtocol,
        receivedIdxMask: instance.receivedIdxMask,
        signalIdx: -1,
        signalData: '',
      });
    }
  }

  private ingestSignal(remotePublicKey: Uint8Array, payload: SignalPayload) {
    const instance = mapPut(
      this.instances,
      bin2prim(payload.signalingNonce),
      () => this.initSignaling(remotePublicKey, payload),
      (inst) => {
        if (
          !arrEquals(inst.remotePublicKey, remotePublicKey) ||
          inst.remoteClientNonce !== payload.srcClientNonce
        ) {
          throw new Error(
            `Ingested signal for nonce ${
              bin2hex(payload.signalingNonce)
            } has a different public key or client nonce!`,
          );
        }

        return inst;
      },
    );

    if (instance.closed) {
      return instance;
    }

    instance.lastIngestTimestamp = this.ctx.config.timeProvider.now();

    if (payload.signalIdx >= 0) {
      const mask = 1n << BigInt(payload.signalIdx);
      if ((instance.receivedIdxMask & mask) === 0n) {
        instance.receivedIdxMask |= mask;

        for (const key of instance.unackedPayloads.keys()) {
          if ((instance.receivedIdxMask & (1n << BigInt(key))) !== 0n) {
            instance.unackedPayloads.delete(key);
          }
        }

        instance.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message:
            `Receiving signal ${payload.signalIdx}: ${payload.signalData}...`,
        });
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(instance);

        instance.provider.recvSignal(payload.signalData, payload.signalIdx);
      }
    }

    return instance;
  }

  private initSignaling(
    remotePublicKey: Uint8Array,
    payload: SignalPayload,
  ): SignalingInstance {
    const networkProvider = this.ctx.get(NetworkService)
      .findProvider(undefined, payload.srcProtocol);
    if (networkProvider === undefined) {
      throw new Error(`No provider connecting to ${payload.srcProtocol}`);
    }

    const state: SignalingState = {
      remotePublicKey,
      remoteClientNonce: payload.srcClientNonce,
      localProtocol: networkProvider.providesProtocol,

      nextEmitIdx: 0,
      unackedPayloads: new Map(),

      receivedIdxMask: 0n,
      lastIngestTimestamp: this.ctx.config.timeProvider.now(),
      closed: false,

      log: this.ctx.config.enableSignalingLogging
        ? [{
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Initialized signaling state: publicKey=${
            bin2hex(remotePublicKey)
          }, nonce=${payload.srcClientNonce}, remoteProtocol=${payload.srcProtocol}`,
        }]
        : undefined,
    };
    this.ctx.maybeGet(SignalingRecordSet)?.dispatchAdd(state);

    const provider = networkProvider.createInstance({
      ctx: this.ctx,

      protocol: state.localProtocol,
      useToken: true,

      sendSignal: (signalData) =>
        this.emit(state, {
          signalingNonce: payload.signalingNonce,
          srcClientNonce: this.ctx.config.clientNonce,
          srcProtocol: state.localProtocol,
          receivedIdxMask: state.receivedIdxMask,
          signalIdx: state.nextEmitIdx++,
          signalData,
        }),
      createConnection: (provider) => {
        if (state.closed) {
          return;
        }

        state.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Creating authenticated connection!`,
        });
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);

        this.ctx.get(ConnectionService).createConnection(
          state.localProtocol,
          provider,
          remotePublicKey,
          state.remoteClientNonce,
        );

        // Close other instances with the same public key
        for (const [_, instance] of this.instances) {
          if (
            instance !== state &&
            arrEquals(instance.remotePublicKey, state.remotePublicKey)
          ) {
            instance.closed = true;
          }
        }
      },
    });

    return Object.assign(state, { provider });
  }
}
