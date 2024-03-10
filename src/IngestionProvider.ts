import { Fact, FactBase, SignedFact } from './FactMeta.ts';

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

export interface IngestionProvider<SubFact extends Fact> {
  readonly type: SubFact['type'];
  readonly isPersistent: boolean;
  readonly isSigned: SubFact extends SignedFact ? true : false;

  // Creates the fact. It doesn't exist until this method returns; calls to FactService.get will throw.
  // Note this has to be an arrow declaration to enable contravariant type checking.
  create: (base: FactBase) => SubFact;

  // // Validates the graph after consuming this fact. Every peer should either pass or call invalidate equivalently, given the same graph.
  // // Don't throw; even if this fact is invalid. Invalidate. Other facts could be invalidated too.
  // check(fact: SubFact): void;

  // Ingest the fact. Launches generators and other things.
  ingest: (fact: SubFact) => void;

  forget: (fact: SubFact) => void;
}
