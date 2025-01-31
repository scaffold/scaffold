import { Context } from '../Context.ts';
import { FactBase, KnowledgeFact } from '../FactMeta.ts';
import { FactType } from '../FactMeta.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { KnowledgeMonitor } from '../KnowledgeMonitor.ts';

export class KnowledgeIngestor implements IngestionProvider<KnowledgeFact> {
  type = FactType.Knowledge as const;
  isPersistent = false;
  isSigned = true;

  constructor(private ctx: Context) {}

  create(base: FactBase) {
    return Object.assign(base, { type: FactType.Knowledge as const });
  }

  ingest(fact: KnowledgeFact) {
    fact.fromConnections[0].get(KnowledgeMonitor).ingest(fact.message, fact.receivedAt);
  }

  forget(fact: KnowledgeFact) {}
}
