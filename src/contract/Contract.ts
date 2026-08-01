import { Context } from '../Context.ts';
import { Block, Draft, DraftPayload, Predicate } from '../graph/types.ts';
import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { Reader } from './Reader.ts';
import { WalkerHost } from './values.ts';

export interface ContractProvider {
  generate(
    predicate: Predicate,
    draft: Draft,
    signal: AbortSignal,
  ): MaybePromise<void>;

  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): MaybePromise<void>;

  walkParams?(
    contract: Hash,
    params: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void>;

  walkData?(
    contract: Hash,
    data: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void>;

  buildParams?(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array>;

  buildData?(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array>;

  debugName?(predicate: Predicate): string | undefined;
}

export interface ContractPlugin {
  new (ctx: Context): ContractProvider;
}
