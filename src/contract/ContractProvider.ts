import { Block, Draft, Predicate } from '../graph/types.ts';
import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { FlowCtl } from '../util/RunQueue.ts';
import { SinkRoot, SourceRoot } from './values.ts';

export interface ContractProvider {
  generate(predicate: Predicate, draft: Draft, flowCtl: FlowCtl): MaybePromise<void>;
  verify(predicate: Predicate, block: Block, flowCtl: FlowCtl): MaybePromise<void>;

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array>;
  buildData(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array>;

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void>;
  walkData(contract: Hash, data: Uint8Array, sink: SinkRoot): MaybePromise<void>;

  debug?(predicate: Predicate): string | undefined;
}
