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
import { arrEquals } from './util/buffer.ts';
import { SignalingRecordSet } from './record_sets/SignalingRecordSet.ts';
import { KeyService } from './KeyService.ts';

const closeTimeoutMs = 30000;

export interface SignalingState {
  remotePublicKey: Uint8Array;
  nextEmitIdx: number;
  ingestedIndices: bigint;
  lastIngestTimestamp: number;

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

  public isConnecting(publicKey: Uint8Array) {
    for (const [_, state] of this.instances) {
      if (arrEquals(state.remotePublicKey, publicKey)) {
        return true;
      }
    }
    return false;
  }

  public emit(state: SignalingState, payload: SignalPayload) {
    state.log?.push({
      timestamp: this.ctx.config.timeProvider.now(),
      message: `Sending signal ${payload.idx}: ${payload.signal}...`,
    });
    this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);

    this.ctx.get(CryptoHelper).encrypt({
      plaintext: SignalPayload.encode(payload),
      remotePublicKey: state.remotePublicKey,
    }).then((payload) => {
      const signal = { dstPublicKey: state.remotePublicKey, payload };
      this.ctx.get(FactService)
        .emit(signal, ConnectionSignal, FactType.ConnectionSignal, true);
    }).then(() => {
      state.log?.push({
        timestamp: this.ctx.config.timeProvider.now(),
        message: `Sent!`,
      });
      this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);
    }, (err) => {
      state.log?.push({
        timestamp: this.ctx.config.timeProvider.now(),
        message: `Failed!`,
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

    if (
      arrEquals(
        signal.dstPublicKey,
        this.ctx.get(KeyService).getSelfPublicKey(),
      )
    ) {
      const remotePublicKey = this.ctx.get(FactService).getPublicKey(fact);
      this.ctx.get(CryptoHelper).decrypt({
        ciphertext: signal.payload,
        remotePublicKey,
      }).then((data) =>
        this.ingestSignal(remotePublicKey, SignalPayload.decode(data))
      ).catch((err) => console.error(err));
    } else {
      const node = this.ctx.get(PeerManager).getPeer(signal.dstPublicKey);
      if (node !== undefined) {
        const conn = this.ctx.get(PeerManager).pathTo(node);
        if (conn !== undefined) {
          this.ctx.get(FactService).sendTo(fact, conn);
        }
      }
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }

  public init(
    remotePublicKey: Uint8Array,
    srcProtocol: string,
    dstProtocol: string,
  ) {
    const nonce = Hash.random().toHex();

    const state = this.ctx.get(SignalingService).ingestSignal(
      remotePublicKey,
      { srcProtocol, dstProtocol, nonce, idx: -1, signal: '' },
    );

    if (state.nextEmitIdx === 0) {
      this.emit(state, {
        srcProtocol: dstProtocol,
        dstProtocol: srcProtocol,
        nonce,
        idx: -1,
        signal: '',
      });
    }
  }

  private ingestSignal(remotePublicKey: Uint8Array, payload: SignalPayload) {
    console.log(`Ingested signal from ${bin2hex(remotePublicKey)}:`, payload);

    const instance = mapPut(
      this.instances,
      payload.nonce,
      () => this.initSignaling(remotePublicKey, payload),
      (instance) => {
        instance.lastIngestTimestamp = this.ctx.config.timeProvider.now();
        return instance;
      },
    );

    if (payload.idx >= 0) {
      const mask = 1n << BigInt(payload.idx);
      if ((instance.ingestedIndices & mask) === 0n) {
        instance.ingestedIndices |= mask;

        instance.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Receiving signal ${payload.idx}: ${payload.signal}...`,
        });
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(instance);

        instance.provider.recvSignal(payload.signal, payload.idx);
      }
    }

    return instance;
  }

  private initSignaling(
    remotePublicKey: Uint8Array,
    payload: Pick<SignalPayload, 'srcProtocol' | 'dstProtocol' | 'nonce'>,
  ): SignalingInstance {
    const state: SignalingState = {
      remotePublicKey,
      nextEmitIdx: 0,
      ingestedIndices: 0n,
      lastIngestTimestamp: this.ctx.config.timeProvider.now(),
      log: this.ctx.config.enableSignalingLogging
        ? [{
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Initialized signaling state: publicKey=${
            bin2hex(remotePublicKey)
          }, nonce=${payload.nonce}, protocol=${payload.dstProtocol}, remoteProtocol=${payload.srcProtocol}`,
        }]
        : undefined,
    };
    this.ctx.maybeGet(SignalingRecordSet)?.dispatchAdd(state);

    const networkProvider = this.ctx.get(NetworkService)
      .findProvider(payload.dstProtocol, payload.srcProtocol);
    if (networkProvider === undefined) {
      throw new Error(`No provider connecting to ${payload.srcProtocol}`);
    }

    const provider = networkProvider.createInstance({
      ctx: this.ctx,

      protocol: payload.dstProtocol,
      useToken: true,

      sendSignal: (signal) =>
        this.emit(state, {
          srcProtocol: payload.dstProtocol,
          dstProtocol: payload.srcProtocol,
          nonce: payload.nonce,
          idx: state.nextEmitIdx++,
          signal,
        }),
      createConnection: (provider) => {
        state.log?.push({
          timestamp: this.ctx.config.timeProvider.now(),
          message: `Creating authenticated connection!`,
        });
        this.ctx.maybeGet(SignalingRecordSet)?.dispatchUpdate(state);

        this.ctx.get(ConnectionService)
          .createConnection(payload.dstProtocol, provider, remotePublicKey);
      },
    });

    return Object.assign(state, { provider });
  }
}
