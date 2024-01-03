import { FactBase, FactSource, FactType, SignalFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { Signal } from '~/sbl/messages.ts';
import Hash from '~/sbl/util/Hash.ts';
import KeyService from '~/sbl/KeyService.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import ClockService from '~/sbl/ClockService.ts';
import ConnectionService2 from '~/sbl/ConnectionService2.ts';

export default class SignalingService {
  private selfDst: Hash;

  constructor(private ctx: Context) {
    this.selfDst = Hash.digest(ctx.get(KeyService).getSelfPublicKey());
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
      this.ctx.get(ConnectionService2).recvSignal(fact);
    } else {
      // TODO
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      0,
    );

    return fact;
  }
}
