import { Hash } from '../../util/Hash.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';

export enum ExecutionMode {
  Generation = 0,
  Verification = 1,
}

export interface ContractEnv {
  mode(): ExecutionMode;

  contractHash(): Hash;
  params(): Uint8Array;

  claim(): MaybePromise<Uint8Array>;

  setResult(result: Uint8Array): void;
}
