import {
  ConnectionSignalFact,
  FactBase,
  FactSource,
  FactType,
} from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { ConnectionSignal } from '~/sbl/messages.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import KeyService from '~/sbl/KeyService.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import ClockService from '~/sbl/ClockService.ts';
import { SignalingProvider } from '~/sbl/NetworkProvider.ts';
import NetworkService from '~/sbl/NetworkService.ts';
import { mapPut } from '~/sbl/util/map.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { assert } from '~/sbl/util/functional.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';

const closeTimeoutMs = 30000;

interface SignalingState {
  remotePublicKey: Uint8Array;
  outgoingSignalIdx: number;
  incomingSignalIdx: number;
  incomingSignalBuffer: (string | undefined)[];
  signalingProvider: SignalingProvider;
  closeTimeout?: number;

  sendSignal(data: string): void;
  forget(stateHash: Hash): void;
}

export default class SignalingService {
  private states = new Map<HashPrimitive, SignalingState>();

  constructor(private ctx: Context) {
    ctx.onDestruct(() => {
      for (const [_key, state] of this.states) {
        if (state.closeTimeout !== undefined) {
          this.ctx.config.timeProvider.clearTimeout(state.closeTimeout);
        }
      }
    });
  }

  public emit(signal: ConnectionSignal): ConnectionSignalFact {
    const data = this.ctx.get(FactService)
      .compose(signal, ConnectionSignal, FactType.ConnectionSignal);

    // I know we're encoding/decoding redundantly here, and we can possibly make this faster later, but for now let's make everything go through the same code path
    const fact = this.ctx.get(FactService).ingest(
      data,
      FactSource.Local,
      this.ctx.get(NodeService).getSelfNode(),
    );
    if (fact.type !== FactType.ConnectionSignal) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }

    this.ctx.get(FactService).publish(fact);

    return fact;
  }

  public createFact(base: FactBase): ConnectionSignalFact {
    const fact: ConnectionSignalFact = Object.assign(
      base,
      ConnectionSignal.decode(base.message),
      { type: FactType.ConnectionSignal as const },
    );

    if (
      arrEquals(fact.public_key, this.ctx.get(KeyService).getSelfPublicKey())
    ) {
      this.handleSignal(fact);
    } else {
      // TODO
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }

  private handleSignal(signal: ConnectionSignalFact) {
    const state = this.getSignalingState(signal);
    if (signal.signal_index >= 0) {
      state.incomingSignalBuffer[signal.signal_index] = signal.signal_data;
      while (true) {
        const sig = state.incomingSignalBuffer[state.incomingSignalIdx];
        if (sig === undefined) {
          break;
        }
        state.signalingProvider.recvSignal(sig);
        state.incomingSignalIdx++;
      }
    }

    // if (state.outgoingSignalIdx === 0 && state.incomingSignalIdx === 0) {
    //   state.outgoingSignalIdx = -1;
    //   state.sendSignal('');
    //   state.outgoingSignalIdx = 1;
    // }
  }

  private isInitiator(signal: ConnectionSignalFact) {
    return signal.is_initiator === signal.isSignedByMe;
  }

  private getStateKey(publicKey: Uint8Array, signal: ConnectionSignalFact) {
    return Hash.digestParts(
      publicKey,
      signal.protocol_name,
      this.isInitiator(signal) ? 0 : 1,
    );
  }

  private getSignalingState(signal: ConnectionSignalFact) {
    const publicKey = this.ctx.get(FactService).getPublicKey(signal);
    const stateKey = this.getStateKey(publicKey, signal);
    const state = mapPut(
      this.states,
      stateKey.toPrimitive(),
      () => this.initSignalingState(publicKey, signal),
    );
    if (state.closeTimeout !== undefined) {
      this.ctx.config.timeProvider.clearTimeout(state.closeTimeout);
    }
    state.closeTimeout = this.ctx.config.timeProvider.setTimeout(
      () => state.forget(stateKey),
      closeTimeoutMs,
    );
    return state;
  }

  private initSignalingState(
    publicKey: Uint8Array,
    signal: ConnectionSignalFact,
  ) {
    // If we don't have an initial signal from the peer, we need a provider able to send their address
    const subtype = signal.signal_index < 0 ? 'client' : undefined;

    const provider = this.ctx.get(NetworkService)
      .findProviderMatching({ name: signal.protocol_name, subtype });
    if (provider === undefined) {
      throw new Error(
        `No provider matching ${signal.protocol_name}/${subtype}`,
      );
    }

    const sendSignal = (data: string) =>
      this.ctx.get(SignalingService).emit({
        public_key: publicKey,
        is_initiator: this.isInitiator(signal),
        protocol_name: signal.protocol_name,
        signal_index: state.outgoingSignalIdx++,
        signal_data: data,
      });

    const forget = (stateHash: Hash) => {
      console.info(`Forgetting signaling state ${stateHash}`);
      assert(this.states.delete(stateHash.toPrimitive()));
    };

    const signalingProvider = provider.createInstance({
      ctx: this.ctx,

      protocolName: signal.protocol_name,
      isInitiator: this.isInitiator(signal),

      sendSignal,
      createConnection: (provider) =>
        this.ctx.get(ConnectionService)
          .createConnection(publicKey, signal.protocol_name, provider),
    });

    const state: SignalingState = {
      remotePublicKey: publicKey,
      outgoingSignalIdx: -1,
      incomingSignalIdx: -1,
      incomingSignalBuffer: [],
      signalingProvider,
      sendSignal,
      forget,
    };
    return state;
  }
}
