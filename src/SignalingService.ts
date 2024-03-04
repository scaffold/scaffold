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
import { FactEmitter, FactGenerator } from './FactEmitter.ts';
import { FactSource } from './FactMeta.ts';

const closeTimeoutMs = 30000;

export interface SignalingState {
  signalingNonce: Uint8Array;
  remotePublicKey: Uint8Array;
  remoteClientNonce: string;
  localProtocol: string;

  nextEmitIdx: number;
  localReceivedIdxMask: bigint;
  remoteReceivedIdxMask: bigint;
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
    this.ctx.get(ClockService).setPoissonInterval(() => {
      const threshold = this.ctx.config.timeProvider.now() - closeTimeoutMs;
      for (const [key, inst] of this.instances) {
        if (inst.lastIngestTimestamp < threshold) {
          this.close(inst);
          this.instances.delete(key);
          this.ctx.maybeGet(SignalingRecordSet)?.dispatchRemove(inst);
        }
      }
    }, closeTimeoutMs);

    this.ctx.onDestruct(() => {
      for (const [_, inst] of this.instances) {
        this.close(inst);
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

  public emit(
    state: SignalingState,
    signalData: string,
    signalIdx: number | undefined,
    priority: number | undefined,
  ) {
    if (state.closed) {
      return;
    }

    const payload: SignalPayload = {
      signalingNonce: state.signalingNonce,
      srcClientNonce: this.ctx.config.clientNonce,
      srcProtocol: state.localProtocol,
      receivedIdxMask: state.localReceivedIdxMask,
      signalIdx: signalIdx ?? state.nextEmitIdx++,
      signalData,
    };

    const clampedPriority = priority !== undefined
      ? Math.max(0, Math.min(priority, 1))
      : 1;

    let lastEmit: number | undefined;
    let backoff = 2e-3;
    const generator: FactGenerator = {
      name: 'Generator<ConnectionSignal>',
      detail: `${
        bin2hex(state.signalingNonce).slice(0, 10)
      }: ${payload.srcProtocol} #${payload.signalIdx}`,
      estimateValue: () => {
        if (
          state.closed ||
          state.remoteReceivedIdxMask & (1n << BigInt(payload.signalIdx))
        ) {
          this.ctx.config.timeProvider.clearInterval(reweighItvl);
          return 0;
        } else {
          let value = 1e6 * clampedPriority;
          if (lastEmit !== undefined) {
            const duration = this.ctx.config.timeProvider.now() - lastEmit;
            const scale = Math.tanh(Math.log(duration * backoff) * 2) * .5 + .5;
            value *= scale;
          }
          return value;
        }
      },
      estimateSize: () => {
        return 250 + state.signalingNonce.byteLength + signalData.length;
      },
      generate: async () => {
        lastEmit = this.ctx.config.timeProvider.now();
        backoff *= 0.5;

        state.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Sending signal ${payload.signalIdx}: ${payload.signalData}`,
        });
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);

        payload.receivedIdxMask = state.localReceivedIdxMask;
        const payloadData = await this.ctx.get(CryptoHelper).encrypt({
          plaintext: SignalPayload.encode(payload),
          remotePublicKey: state.remotePublicKey,
        });

        const infoFact = this.ctx.get(PeerManager)
          .getPeer(state.remotePublicKey)
          ?.clientInfoFacts.get(state.remoteClientNonce);
        if (infoFact === undefined) {
          throw new Error(`No destination known!`);
        }

        const signal = { replyTo: infoFact.hash, payload: payloadData };
        return this.ctx.get(FactService)
          .emit(signal, ConnectionSignal, FactType.ConnectionSignal);
      },
    };

    const reweighItvl = this.ctx.config.timeProvider.setInterval(
      () => this.ctx.get(FactEmitter).addGenerator(generator),
      200,
    );
    this.ctx.get(FactEmitter).addGenerator(generator);
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
        // for (const conn of this.ctx.get(PeerManager).routeTo(dstFact)) {
        //   this.ctx.get(FactService).sendTo(fact, conn);
        // }
        this.ctx.get(FactEmitter).notify(fact);
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
      this.emit(instance, '', -1, 1);
    }
  }

  private ingestSignal(remotePublicKey: Uint8Array, payload: SignalPayload) {
    const instance = mapPut(
      this.instances,
      bin2prim(payload.signalingNonce),
      () =>
        this.initSignaling(payload.signalingNonce, remotePublicKey, payload),
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

    instance.remoteReceivedIdxMask |= payload.receivedIdxMask;

    if (payload.signalIdx >= 0) {
      const mask = 1n << BigInt(payload.signalIdx);
      if ((instance.localReceivedIdxMask & mask) === 0n) {
        instance.lastIngestTimestamp = this.ctx.config.timeProvider.now();

        instance.localReceivedIdxMask |= mask;

        instance.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message:
            `Receiving signal ${payload.signalIdx}: ${payload.signalData}`,
        });
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(instance);

        instance.provider.recvSignal(payload.signalData, payload.signalIdx);
      }
    }

    return instance;
  }

  private initSignaling(
    signalingNonce: Uint8Array,
    remotePublicKey: Uint8Array,
    payload: SignalPayload,
  ): SignalingInstance {
    const networkProvider = this.ctx.get(NetworkService)
      .findProvider(undefined, payload.srcProtocol);
    if (networkProvider === undefined) {
      throw new Error(`No provider connecting to ${payload.srcProtocol}`);
    }

    const state: SignalingState = {
      signalingNonce,
      remotePublicKey,
      remoteClientNonce: payload.srcClientNonce,
      localProtocol: networkProvider.providesProtocol,

      nextEmitIdx: 0,
      localReceivedIdxMask: 0n,
      remoteReceivedIdxMask: 0n,
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

      sendSignal: (signalData, priority) =>
        this.emit(state, signalData, undefined, priority),
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
            instance !== state && !instance.closed &&
            arrEquals(instance.remotePublicKey, state.remotePublicKey) &&
            instance.remoteClientNonce === state.remoteClientNonce &&
            instance.localProtocol === state.localProtocol
          ) {
            instance.log?.push({
              timestamp: this.ctx.config.timeProvider.now(),
              message:
                `Aborting because we created another connection to this peer!`,
            });
            this.close(instance);
          }
        }

        // Close this instance
        this.ctx.get(ClockService).setTimeout(() => this.close(state), 0);
      },
    });

    return Object.assign(state, { provider });
  }

  private close(state: SignalingState | SignalingInstance) {
    if (state.closed) {
      return;
    }

    state.closed = true;

    if ('provider' in state) {
      state.provider.dispose?.();
    }
  }
}
