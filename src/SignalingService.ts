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

const closeTimeoutMs = 30000;

interface SignalingState {
  remotePublicKey: Uint8Array;
  nextEmitIdx: number;
  // sentInitSignal: boolean;
  // outgoingSignalIdx: number;
  // incomingSignalIdx: number;
  // incomingSignalBuffer: (string | undefined)[];
  // driver: SignalingDriver;
  provider: SignalingProvider;
  lastTouchTimestamp: number;
}

export class SignalingService {
  private states = new Map<string, SignalingState>();

  constructor(private ctx: Context) {}

  public isConnecting(publicKey: Uint8Array) {
    for (const [_, state] of this.states) {
      if (arrEquals(state.remotePublicKey, publicKey)) {
        return true;
      }
    }
    return false;
  }

  public async emit(
    dstPublicKey: Uint8Array,
    payload: SignalPayload,
  ) {
    const signal = {
      dstPublicKey,
      payload: await this.ctx.get(CryptoHelper).encrypt(
        SignalPayload.encode(payload),
        dstPublicKey,
      ),
    };
    this.ctx.get(FactService)
      .emit(signal, ConnectionSignal, FactType.ConnectionSignal, true);
  }

  public createFact(base: FactBase): ConnectionSignalFact {
    const signal = ConnectionSignal.decode(base.message);

    const fact: ConnectionSignalFact = Object.assign(
      base,
      signal,
      { type: FactType.ConnectionSignal as const },
    );

    const node = this.ctx.get(PeerManager).get(signal.dstPublicKey);
    if (node !== undefined) {
      if (node.isRemote) {
        const conn = this.ctx.get(PeerManager).pathTo(node);
        if (conn !== undefined) {
          this.ctx.get(FactService).sendTo(fact, conn);
        }
      } else {
        const remotePublicKey = this.ctx.get(FactService).getPublicKey(fact);
        this.ctx.get(CryptoHelper).decrypt(signal.payload, remotePublicKey)
          .then((data) =>
            this.ingestSignal(remotePublicKey, SignalPayload.decode(data))
          )
          .catch((err) => console.error(err));
      }
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }

  public ingestSignal(remotePublicKey: Uint8Array, payload: SignalPayload) {
    console.log(`Ingested signal from ${bin2hex(remotePublicKey)}:`, payload);

    const state = mapPut(
      this.states,
      payload.nonce,
      () => this.initSignalingState(remotePublicKey, payload),
      (state) => {
        state.lastTouchTimestamp = this.ctx.config.timeProvider.now();
        return state;
      },
    );

    if (payload.idx >= 0) {
      state.provider.recvSignal(payload.signal, payload.idx);
    }
  }

  private initSignalingState(
    remotePublicKey: Uint8Array,
    payload: Pick<SignalPayload, 'srcProtocol' | 'dstProtocol' | 'nonce'>,
  ): SignalingState {
    const state: Omit<SignalingState, 'provider'> = {
      remotePublicKey,
      nextEmitIdx: 0,
      lastTouchTimestamp: this.ctx.config.timeProvider.now(),
    };

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
        this.emit(remotePublicKey, {
          srcProtocol: payload.dstProtocol,
          dstProtocol: payload.srcProtocol,
          nonce: payload.nonce,
          idx: state.nextEmitIdx++,
          signal,
        }).catch((err) => console.error(err)),
      createConnection: (provider) =>
        this.ctx.get(ConnectionService)
          .createConnection(payload.dstProtocol, provider, remotePublicKey),
    });

    return Object.assign(state, { provider });
  }
}
