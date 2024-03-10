import { SignedFact } from '../FactMeta.ts';
import { FactBase, FactType, SignalPayloadFact } from '../FactMeta.ts';
import { IngestionProvider } from '../IngestionProvider.ts';

export class SignalPayloadIngestor
  implements IngestionProvider<SignalPayloadFact> {
  type = FactType.SignalPayload as const;
  isPersistent = false;
  isSigned = false as const;

  create(base: FactBase) {
    return {} as SignalPayloadFact;
  }

  ingest(fact: SignalPayloadFact) {
    throw new Error('Method not implemented.');
  }

  forget(fact: SignalPayloadFact) {
    throw new Error('Method not implemented.');
  }
}
