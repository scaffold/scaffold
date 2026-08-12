import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractEnv } from './ContractEnv.ts';
import { FlowCtl } from '../../util/RunQueue.ts';
import { SinkRoot, SourceRoot } from '../values.ts';
import { Hash } from '../../util/Hash.ts';

export interface Contract {
  // outputNamespaces: Hash[];

  run(env: ContractEnv, flowCtl: FlowCtl): MaybePromise<void>;

  buildParams?(source: SourceRoot): MaybePromise<Uint8Array>;
  buildBody?(source: SourceRoot): MaybePromise<Uint8Array>;

  walkParams?(params: Uint8Array, sink: SinkRoot): MaybePromise<void>;
  walkBody?(body: Uint8Array, sink: SinkRoot): MaybePromise<void>;

  debug?(params: Uint8Array, ctx: Context): string;
}
