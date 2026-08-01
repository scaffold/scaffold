import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractEnv } from './ContractEnv.ts';
import { FlowCtl } from '../../util/RunQueue.ts';

export interface Contract {
  run(env: ContractEnv, flowCtl: FlowCtl): MaybePromise<void>;

  debug?(params: Uint8Array, ctx: Context): string;
}
