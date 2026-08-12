import { Block, Draft, Predicate } from '../graph/types.ts';
import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { FlowCtl } from '../util/RunQueue.ts';
import { SinkRoot, SourceRoot } from './values.ts';

export interface PutRequest {
  body?: Uint8Array;
}

export interface ContractProvider {
  generate(
    predicate: Predicate,
    put: PutRequest | undefined,
    draft: Draft,
    flowCtl: FlowCtl,
  ): MaybePromise<void>;
  verify(predicate: Predicate, block: Block, flowCtl: FlowCtl): MaybePromise<boolean>;

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array>;
  buildBody(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array>;

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void>;
  walkBody(contract: Hash, body: Uint8Array, sink: SinkRoot): MaybePromise<void>;

  debug?(predicate: Predicate): string | undefined;
}
