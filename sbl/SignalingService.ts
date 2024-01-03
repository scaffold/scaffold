import { FactBase, FactSource, FactType, SignalFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { Signal } from '~/sbl/messages.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import KeyService from '~/sbl/KeyService.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import ClockService from '~/sbl/ClockService.ts';
import { SignalingProvider } from '~/sbl/NetworkProvider.ts';
import NetworkService from '~/sbl/NetworkService.ts';
import { mapPut } from '~/sbl/util/map.ts';

const closeTimeoutMs = 30000;

interface SignalingState {
  remotePublicKey: Uint8Array;
  outgoingSignalIdx: number;
  incomingSignalIdx: number;
  incomingSignalBuffer: (string | undefined)[];
  signalingProvider: SignalingProvider;
  closeTimeout?: number;
}

export default class SignalingService {
  private selfDst: Hash;
  private states = new Map<HashPrimitive, SignalingState>();

  constructor(private ctx: Context) {
    this.selfDst = Hash.digest(ctx.get(KeyService).getSelfPublicKey());

    ctx.onDestruct(() => {
      for (const [_key, state] of this.states) {
        if (state.closeTimeout !== undefined) {
          this.ctx.config.timeProvider.clearTimeout(state.closeTimeout);
        }
      }
    });
  }

  public emit(signal: Signal): SignalFact {
    const data = this.ctx.get(FactService)
      .compose(signal, Signal, FactType.Signal);

    // I know we're encoding/decoding redundantly here, and we can possibly make this faster later, but for now let's make everything go through the same code path
    const fact = this.ctx.get(FactService).ingest(
      data,
      FactSource.Local,
      this.ctx.get(NodeService).getSelfNode(),
    );
    if (fact.type !== FactType.Signal) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }

    this.ctx.get(FactService).publish(fact);

    return fact;
  }

  public createFact(base: FactBase): SignalFact {
    const fact: SignalFact = Object.assign(
      base,
      Signal.decode(base.message),
      { type: FactType.Signal as const },
    );

    if (Hash.equals(fact.destination, this.selfDst)) {
      this.recvSignal(fact);
    } else {
      // TODO
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }

  private recvSignal(signal: SignalFact) {
    const conn = this.getSignalingState(signal);
    if (signal.signal_index >= 0) {
      conn.incomingSignalBuffer[signal.signal_index] = signal.signal_data;
      while (true) {
        const sig = conn.incomingSignalBuffer[conn.incomingSignalIdx];
        if (sig === undefined) {
          break;
        }
        conn.signalingProvider.recvSignal(sig);
        conn.incomingSignalIdx++;
      }
    }
  }

  private getSignalingState(signal: SignalFact) {
    const publicKey = this.ctx.get(FactService).getPublicKey(signal);
    const stateHash = Hash.digestParts(
      publicKey,
      signal.connection_nonce,
      signal.protocol_name,
    );
    const state = mapPut(
      this.states,
      stateHash.toPrimitive(),
      () => this.initSignalingState(publicKey, signal),
    );
    if (state.closeTimeout !== undefined) {
      this.ctx.config.timeProvider.clearTimeout(state.closeTimeout);
    }
    state.closeTimeout = this.ctx.config.timeProvider.setTimeout(
      () => this.forget(stateHash),
      closeTimeoutMs,
    );
    return state;
  }

  private initSignalingState(publicKey: Uint8Array, signal: SignalFact) {
    // If we don't have an initial signal from the peer, we need a provider able to send their address
    const subtype = signal.signal_index < 0 ? 'client' : undefined;

    const provider = this.ctx.get(NetworkService)
      .findProviderMatching({ name: signal.protocol_name, subtype });
    if (provider === undefined) {
      throw new Error(
        `No provider matching ${signal.protocol_name}/${subtype}`,
      );
    }

    const signalingProvider = provider.createInstance({
      ctx: this.ctx,

      protocolName: signal.protocol_name,
      isInitiator: false,
      isDialer: false,

      sendSignal: (data) =>
        this.ctx.get(SignalingService).emit({
          destination: Hash.digest(publicKey),
          connection_nonce: signal.connection_nonce,
          protocol_name: signal.protocol_name,
          signal_index: state.outgoingSignalIdx++,
          signal_data: data,
        }),
      createConnection: (provider) => {
        throw new Error(`TODO: Create connection`);
        // Don't drop the signaling state here because it may create additional connections
      },
    });

    const state: SignalingState = {
      remotePublicKey: publicKey,
      outgoingSignalIdx: 0,
      incomingSignalIdx: 0,
      incomingSignalBuffer: [],
      signalingProvider,
    };
    return state;
  }

  private forget(stateHash: Hash) {
    console.info(`Forgetting signaling state ${stateHash}`);
    this.states.delete(stateHash.toPrimitive());
  }
}
