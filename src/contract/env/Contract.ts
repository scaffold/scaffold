import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractEnv } from './ContractEnv.ts';

export interface Contract {
  run(env: ContractEnv, signal: AbortSignal): MaybePromise<void>;

  debug?(params: Uint8Array, ctx: Context): string;
}
