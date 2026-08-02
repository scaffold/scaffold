import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ContractProvider } from './ContractProvider.ts';
import { MissingContractProvider } from './MissingContractProvider.ts';
import { Block, Draft, DraftPayload, Predicate } from '../graph/types.ts';
import { FlowCtl } from '../util/RunQueue.ts';
import { WalkerHost } from './values.ts';
import { Reader } from './Reader.ts';

export class RoutingContractProvider implements ContractProvider {
  private map = new Map<HashPrimitive, ContractProvider>();

  constructor(
    _ctx: Context,
    contracts: { hash: Hash; provider: ContractProvider }[],
    private base: ContractProvider = new MissingContractProvider(),
  ) {
    for (const { hash, provider } of contracts) {
      this.map.set(hash.toPrimitive(), provider);
    }
  }

  generate(
    predicate: Predicate,
    draft: Draft,
    flowCtl: FlowCtl,
  ): MaybePromise<void> {
    return this.getProvider(predicate.contract).generate(predicate, draft, flowCtl);
  }

  verify(
    predicate: Predicate,
    block: Block,
    flowCtl: FlowCtl,
  ): MaybePromise<void> {
    return this.getProvider(predicate.contract).verify(predicate, block, flowCtl);
  }

  buildParams(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array> {
    return this.getProvider(contract).buildParams(contract, reader);
  }

  buildData(
    contract: Hash,
    reader: (descriptor: string) => MaybePromise<Reader>,
  ): MaybePromise<Uint8Array> {
    return this.getProvider(contract).buildData(contract, reader);
  }

  walkParams(
    contract: Hash,
    params: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void> {
    return this.getProvider(contract).walkParams(contract, params, host);
  }

  walkData(
    contract: Hash,
    data: Uint8Array,
    host: WalkerHost,
  ): MaybePromise<void> {
    return this.getProvider(contract).walkData(contract, data, host);
  }

  debug?(predicate: Predicate): string | undefined {
    return this.getProvider(predicate.contract).debug?.(predicate);
  }

  private getProvider(contract: Hash): ContractProvider {
    return this.map.get(contract.toPrimitive()) ?? this.base;
  }
}
