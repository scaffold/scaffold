import { ClockService } from '../ClockService.ts';
import { Context } from '../Context.ts';
import { CryptoHelper } from '../CryptoHelper.ts';
import { FactEmitter } from '../FactEmitter.ts';
import { FactBase } from '../FactMeta.ts';
import { ConnectionSignalFact, FactSource, FactType } from '../FactMeta.ts';
import { FactService } from '../FactService.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { SignalingService } from '../SignalingService.ts';
import { ConnectionSignal, SignalPayload } from '../messages.ts';

export class ConnectionSignalIngestor implements IngestionProvider<ConnectionSignalFact> {
  type = FactType.ConnectionSignal as const;
  isPersistent = true;
  isSigned = true;

  constructor(private ctx: Context) {}

  create(base: FactBase) {
    return Object.assign(
      base,
      ConnectionSignal.decode(base.message),
      { type: FactType.ConnectionSignal as const },
    );
  }

  ingest(fact: ConnectionSignalFact) {
    const dstFact = this.ctx.get(FactService).get(fact.replyTo, false);
    if (dstFact !== undefined) {
      if (dstFact.source === FactSource.Local) {
        const remotePublicKey = this.ctx.get(FactService).getPublicKey(fact);
        this.ctx.get(CryptoHelper).decrypt({
          ciphertext: fact.payload,
          remotePublicKey,
        }).then((data) => {
          console.log(
            `Decrypted signal`,
            fact.hash.toHex().slice(0, 10),
            SignalPayload.decode(data),
          );

          this.ctx.get(SignalingService).ingestSignal(
            remotePublicKey,
            SignalPayload.decode(data),
          );
        }).catch((err) => console.error(err));
      } else {
        // for (const conn of this.ctx.get(PeerManager).routeTo(dstFact)) {
        //   this.ctx.get(FactService).sendTo(fact, conn);
        // }
        this.ctx.get(FactEmitter).notify(fact);
      }
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactService).forget(fact),
      10000,
    );
  }

  forget(fact: ConnectionSignalFact) {}
}
