import { Fact } from './FactMeta.ts';
import { FactType } from './FactMeta.ts';

/*
Decompress & extract type
Test fact limit
Dispatch to ingestor
  this.buildBase(data, isSigned, setIngesting)
  Compose
  this.saveFact(fact)
  Further processing

Loaded ingestors are configurable. We can disable, for example, block ingestion, by removing the ingestor
*/

interface IngestionDriver {
}

export interface IngestionProvider {
  readonly type: FactType;
  readonly isSigned: boolean;

  ingest(data: Uint8Array): Fact;
  ingest(fact: Partial<Fact>): void;

  forget(fact: Fact): void;
}
