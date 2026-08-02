import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractEnv } from './ContractEnv.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { SinkRoot, SourceRoot } from '../values.ts';

export interface Contract {
  run(env: ContractEnv, flowCtl: FlowCtl): MaybePromise<void>;

  buildParams?(source: SourceRoot): MaybePromise<Uint8Array>;
  buildData?(source: SourceRoot): MaybePromise<Uint8Array>;

  walkParams?(params: Uint8Array, sink: SinkRoot): MaybePromise<void>;
  walkData?(data: Uint8Array, sink: SinkRoot): MaybePromise<void>;

  debug?(params: Uint8Array, ctx: Context): string;
}
