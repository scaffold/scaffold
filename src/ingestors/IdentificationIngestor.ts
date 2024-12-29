import { ClockService } from '../ClockService.ts';
import { Context } from '../Context.ts';
import { CryptoHelper } from '../CryptoHelper.ts';
import { FactEmitter } from '../FactEmitter.ts';
import { FactBase } from '../FactMeta.ts';
import { FactSource, FactType, IdentificationFact } from '../FactMeta.ts';
import { FactService } from '../FactService.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { SignalingService } from '../SignalingService.ts';
import { Identification, SignalPayload } from '../messages.ts';

export class IdentificationIngestor implements IngestionProvider<IdentificationFact> {
  type = FactType.Identification as const;
  isPersistent = false;
  isSigned = true;

  constructor(private ctx: Context) {}

  create(base: FactBase) {
    return Object.assign(
      base,
      Identification.decode(base.message),
      { type: FactType.Identification as const },
    );
  }

  ingest(fact: IdentificationFact) {}

  forget(fact: IdentificationFact) {
    throw new Error(`An identification fact should not be forgotten!`);
  }
}
