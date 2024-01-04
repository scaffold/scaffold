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
import { bin2hex } from '~/sbl/util/hex.ts';

const closeTimeoutMs = 30000;

interface SignalingState {
  remotePublicKey: Uint8Array;
  sentInitSignal: boolean;
  outgoingSignalIdx: number;
  incomingSignalIdx: number;
  incomingSignalBuffer: (string | undefined)[];
  signalingProvider: SignalingProvider;
  closeTimeout?: number;
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

  public isConnecting(publicKey: Uint8Array, protocolName: string) {
    return this.states.has(
      Hash.digestParts(publicKey, protocolName, 0).toPrimitive(),
    ) || this.states.has(
      Hash.digestParts(publicKey, protocolName, 1).toPrimitive(),
    );
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

    const node = this.ctx.get(NodeService).get(fact.dst_public_key);
    if (node !== undefined) {
      if (node.isRemote) {
        this.ctx.get(FactService).sendTo(fact, node);
      } else {
        const fromPublicKey = this.ctx.get(FactService).getPublicKey(fact);
        this.ingestSignal(fromPublicKey, fact);
      }
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }

  public ingestSignal(publicKey: Uint8Array, signal: IngestingSignal) {
    console.log(
      `Ingested signal from ${bin2hex(publicKey)}:`,
      signal.protocol_name,
      signal.signal_index,
      signal.signal_data,
    );
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

    if (
      !state.sentInitSignal &&
      state.outgoingSignalIdx === 0 &&
      state.incomingSignalIdx === 0
    ) {
      state.sentInitSignal = true;
      this.emit({
        dst_public_key: publicKey,
        is_initiator: signal.isSelfInitiator,
        protocol_name: signal.protocol_name,
        signal_index: -1,
        signal_data: '',
      });
    }
  }

  private getSignalingState(publicKey: Uint8Array, signal: IngestingSignal) {
    const stateKey = Hash.digestParts(
      publicKey,
      signal.protocol_name,
      signal.isSelfInitiator ? 0 : 1,
    );
    const state = mapPut(
      this.states,
      stateKey.toPrimitive(),
      () => this.initSignalingState(publicKey, signal),
    );
    if (state.closeTimeout !== undefined) {
      this.ctx.config.timeProvider.clearTimeout(state.closeTimeout);
    }
    state.closeTimeout = this.ctx.config.timeProvider.setTimeout(
      () => {
        console.info(`Forgetting signaling state ${stateKey.toHex()}`);
        assert(this.states.delete(stateKey.toPrimitive()));
      },
      closeTimeoutMs,
    );
    return state;
  }

  private initSignalingState(
    publicKey: Uint8Array,
    signal: IngestingSignal,
  ): SignalingState {
    const state: Omit<SignalingState, 'signalingProvider'> = {
      remotePublicKey: publicKey,
      sentInitSignal: false,
      outgoingSignalIdx: 0,
      incomingSignalIdx: 0,
      incomingSignalBuffer: [],
    };

    const sendSignal = (data: string) =>
      this.emit({
        dst_public_key: publicKey,
        is_initiator: signal.isSelfInitiator,
        protocol_name: signal.protocol_name,
        signal_index: state.outgoingSignalIdx++,
        signal_data: data,
      });

    // If we don't have an initial signal from the peer, we need a provider able to send their address
    const subtype = signal.signal_index < 0 ? 'client' : undefined;

    const signalingProvider = this.ctx.get(NetworkService).initConnection(
      { name: signal.protocol_name, subtype },
      publicKey,
      sendSignal,
    );

    return Object.assign(state, { signalingProvider });
  }
}
