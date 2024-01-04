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

type IngestingSignal = Pick<
  ConnectionSignalFact,
  'protocol_name' | 'signal_index' | 'signal_data' | 'isSelfInitiator'
>;

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
    return this.ctx.get(FactService)
      .emit(signal, ConnectionSignal, FactType.ConnectionSignal, true);
  }

  public createFact(base: FactBase): ConnectionSignalFact {
    const signal = ConnectionSignal.decode(base.message);

    const fact: ConnectionSignalFact = Object.assign(
      base,
      signal,
      { type: FactType.ConnectionSignal as const },
      { isSelfInitiator: signal.is_initiator === base.isSignedByMe },
    );

    if (
      arrEquals(
        fact.dst_public_key,
        this.ctx.get(KeyService).getSelfPublicKey(),
      )
    ) {
      const fromPublicKey = this.ctx.get(FactService).getPublicKey(fact);
      this.ingestSignal(fromPublicKey, fact);
    } else {
      // TODO: Forward
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }

  public ingestSignal(publicKey: Uint8Array, signal: IngestingSignal) {
    const state = this.getSignalingState(publicKey, signal);
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

  private getStateKey(publicKey: Uint8Array, signal: IngestingSignal) {
    return Hash.digestParts(
      publicKey,
      signal.protocol_name,
      signal.isSelfInitiator ? 0 : 1,
    );
  }

  private getSignalingState(publicKey: Uint8Array, signal: IngestingSignal) {
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

  private initSignalingState(publicKey: Uint8Array, signal: IngestingSignal) {
    const sendSignal = (data: string) =>
      this.ctx.get(SignalingService).emit({
        dst_public_key: publicKey,
        is_initiator: signal.isSelfInitiator,
        protocol_name: signal.protocol_name,
        signal_index: state.outgoingSignalIdx++,
        signal_data: data,
      });

    const forget = (stateHash: Hash) => {
      console.info(`Forgetting signaling state ${stateHash.toHex()}`);
      assert(this.states.delete(stateHash.toPrimitive()));
    };

    // If we don't have an initial signal from the peer, we need a provider able to send their address
    const subtype = signal.signal_index < 0 ? 'client' : undefined;

    const signalingProvider = this.ctx.get(NetworkService).initConnection(
      { name: signal.protocol_name, subtype },
      publicKey,
      sendSignal,
    );

    const state: SignalingState = {
      remotePublicKey: publicKey,
      outgoingSignalIdx: 0,
      incomingSignalIdx: 0,
      incomingSignalBuffer: [],
      signalingProvider,
      sendSignal,
      forget,
    };
    return state;
  }
}
