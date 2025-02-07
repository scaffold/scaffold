import { Connection } from './Connection.ts';
import { Fact, FactBase, FactType } from './FactMeta.ts';

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

export interface IngestionProvider<Type extends FactType> {
  readonly type: Type;
  readonly isTransient: false;
  readonly isPersistent: boolean;
  readonly isSigned: boolean;

  // Creates the fact. It doesn't exist until this method returns; calls to FactService.get will throw.
  // Note this has to be an arrow declaration to enable contravariant type checking.
  create(base: FactBase): Fact & { type: Type };

  // Ingest the fact. Launches generators and other things.
  ingest(fact: Fact & { type: Type }): void;

  forget(fact: Fact & { type: Type }): void;
}

export interface ReceptionProvider<Type extends FactType> {
  readonly type: Type;
  readonly isTransient: true;

  handle(from: Connection, data: Uint8Array): void;
}
