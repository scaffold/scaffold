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
import { Logger } from './Logger.ts';
import { LogSystem } from './Config.ts';
import { secp } from './util/secp.ts';

// const closeTimeoutMs = 30000;
const closeTimeoutMs = Infinity;
const attachPriorityToSignal = false;
export const signalPriorityResolution = 16;

export interface SignalingState {
  signalingNonce: Uint8Array;
  isInitiator: boolean;
  remotePublicKey: Uint8Array;
  remoteClientNonce: string;
  localProtocol: string;

  nextEmitIdx: number;
  localReceivedIdxMask: bigint;
  remoteReceivedIdxMask: bigint;
  lastIngestTimestamp: number;

  closed: boolean;

  log?: Logger;
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

    const clampedPriority = priority !== undefined ? Math.max(0, Math.min(priority, 1)) : 1;

    let lastEmit: number | undefined;
    let emits = 0;
    const generator: FactGenerator = {
      describe: () => ({
        name: 'Generator<ConnectionSignal>',
        detail: `${
          bin2hex(state.signalingNonce).slice(0, 10)
        }: ${payload.srcProtocol} #${payload.signalIdx}`,
        emits,
      }),
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
            const backoff = 2e-3 * Math.pow(0.5, emits);
            let scale = Math.tanh(Math.log(duration * backoff) * 2) * .5 + .5;
            scale *= Math.pow(0.5, emits);
            value *= scale;
          }
          return value;
        }
      },
      estimateSize: () => {
        // TODO: Figure out what the packet overhead should be
        return 250 + state.signalingNonce.byteLength + signalData.length;
      },
      generate: async () => {
        lastEmit = this.ctx.config.timeProvider.now();
        emits++;

        state.log?.info(`Sending signal ${payload.signalIdx}: ${payload.signalData}`);
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

        const signal: ConnectionSignal = {
          replyTo: infoFact.hash,
          priority: attachPriorityToSignal
            ? Math.max(
              -0x80000000,
              Math.round(Math.log2(clampedPriority) * signalPriorityResolution),
            )
            : 0,
          payload: payloadData,
        };
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

  public init(
    remotePublicKey: Uint8Array,
    remoteClientNonce: string,
    remoteProtocol: string,
  ) {
    const signalingNonce = Hash.random().toBytes();

    const instance = this.ingestSignal(remotePublicKey, {
      signalingNonce,
      srcClientNonce: remoteClientNonce,
      srcProtocol: remoteProtocol,
      receivedIdxMask: 0n,
      signalIdx: -1,
      signalData: '',
    }, true);

    if (instance.nextEmitIdx === 0) {
      this.emit(instance, '', -1, 1);
    }
  }

  public ingestSignal(remotePublicKey: Uint8Array, payload: SignalPayload, isInitiator: boolean) {
    const instance = mapPut(
      this.instances,
      bin2prim(payload.signalingNonce),
      () => this.initSignaling(payload.signalingNonce, remotePublicKey, payload, isInitiator),
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

        assert(inst.isInitiator === isInitiator);

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

        instance.log?.info(`Receiving signal ${payload.signalIdx}: ${payload.signalData}`);
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
    isInitiator: boolean,
  ): SignalingInstance {
    const networkProvider = this.ctx.get(NetworkService)
      .findProvider(undefined, payload.srcProtocol);
    if (networkProvider === undefined) {
      throw new Error(`No provider connecting to ${payload.srcProtocol}`);
    }

    const state: SignalingState = {
      signalingNonce,
      isInitiator,
      remotePublicKey,
      remoteClientNonce: payload.srcClientNonce,
      localProtocol: networkProvider.providesProtocol,

      nextEmitIdx: 0,
      localReceivedIdxMask: 0n,
      remoteReceivedIdxMask: 0n,
      lastIngestTimestamp: this.ctx.config.timeProvider.now(),
      closed: false,

      log: Logger.create(this.ctx, LogSystem.Signaler),
    };

    state.log?.info(
      `Initialized signaling state: nonce=${bin2hex(signalingNonce)}, publicKey=${
        bin2hex(remotePublicKey)
      }, nonce=${payload.srcClientNonce}, remoteProtocol=${payload.srcProtocol}`,
    );
    this.ctx.maybeGet(SignalingRecordSet)?.dispatchAdd(state);

    const myToken = Hash.digestParts(
      secp.getSharedSecret(this.ctx.config.selfPrivateKey, remotePublicKey),
      signalingNonce,
      isInitiator ? 0 : 1,
    );

    const provider = networkProvider.createInstance({
      ctx: this.ctx,

      protocol: state.localProtocol,
      isInitiator,
      myToken,

      sendSignal: (signalData, priority) => this.emit(state, signalData, undefined, priority),
      createConnection: (remoteToken, provider) => {
        const expectedToken = Hash.digestParts(
          secp.getSharedSecret(this.ctx.config.selfPrivateKey, remotePublicKey),
          signalingNonce,
          isInitiator ? 1 : 0,
        );

        console.log(
          secp.getSharedSecret(this.ctx.config.selfPrivateKey, remotePublicKey),
          signalingNonce,
          isInitiator ? 1 : 0,
          myToken,
          expectedToken,
          remoteToken,
        );

        if (remoteToken === undefined || !Hash.equals(remoteToken, expectedToken)) {
          throw new Error(`Invalid remote token!`);
        }

        // TODO: Handle closed state?
        if (state.closed) {
          throw new Error(`Signaling state is closed!`);
        }

        state.log?.info(`Creating authenticated connection!`);
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);

        const connDriver = this.ctx.get(ConnectionService).createConnection(
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
            instance.log?.info(`Aborting because we created another connection to this peer!`);
            this.close(instance);
          }
        }

        // Close this instance
        this.ctx.get(ClockService).setTimeout(() => this.close(state), 0);

        return connDriver;
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
