import { Fact, FactBase } from './FactMeta.ts';

/*
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
  readonly isSigned: boolean;

  // Creates the fact. It doesn't exist until this method returns; calls to FactService.get will throw.
  // Note this has to be an arrow declaration to enable contravariant type checking.
  create: (base: FactBase) => SubFact;

  // Ingest the fact. Launches generators and other things.
  ingest: (fact: SubFact) => void;

  forget: (fact: SubFact) => void;
}
