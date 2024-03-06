import { Fact, FactBase, FactType } from './FactMeta.ts';

/*
Decompress & extract type
Test fact limit
Dispatch to ingestor
  this.buildBase(data, isSigned, setIngesting)
  Compose
  this.saveFact(fact)
  Further processing

Loaded ingestors are configurable. We can disable, for example, block ingestion, by removing the ingestor

Invalidities:
  IO zero sum
  Timestamp
  Input existence
  Frontier vote existence
  Mergeability (double spends)
  Group verifications (possibly temporary)
  Collateral weight (temporary)
  Input testing (temporary)
*/

export const enum Invalidities {
  None = 0,

  ZeroSum = 1 << 0,
  Timestamp = 1 << 1,
  // ...
}

interface IngestionDriver {
  save(): void;
  invalidate(fact: Fact): void;
}

export interface IngestionProvider<Type extends FactType> {
  readonly type: FactType;
  readonly isSigned: boolean;

  // Creates the fact. It doesn't exist until this method returns; calls to FactService.get will throw.
  create(fact: FactBase): Fact & { type: Type };

  // Validates the graph after consuming this fact. Every peer should either pass or call invalidate equivalently, given the same graph.
  // Don't throw; even if this fact is invalid. Invalidate. Other facts could be invalidated too.
  check(fact: Fact & { type: Type }): void;

  // Ingest the fact. Launches generators and other things.
  ingest(fact: Fact & { type: Type }): void;

  forget(fact: Fact): void;
}
