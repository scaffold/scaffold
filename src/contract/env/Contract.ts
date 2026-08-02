import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractEnv } from './ContractEnv.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { WalkerHost } from '../values.ts';
import { Reader } from '../Reader.ts';

export interface Contract {
  run(env: ContractEnv, flowCtl: FlowCtl): MaybePromise<void>;

  buildParams?(reader: (descriptor: string) => MaybePromise<Reader>): MaybePromise<Uint8Array>;
  buildData?(reader: (descriptor: string) => MaybePromise<Reader>): MaybePromise<Uint8Array>;

  walkParams?(params: Uint8Array, host: WalkerHost): MaybePromise<void>;
  walkData?(data: Uint8Array, host: WalkerHost): MaybePromise<void>;

  debug?(params: Uint8Array, ctx: Context): string;
}
