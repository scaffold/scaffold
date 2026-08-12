import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ContractProvider, PutRequest } from './ContractProvider.ts';
import { MissingContractProvider } from './MissingContractProvider.ts';
import { Block, Draft, Predicate } from '../graph/types.ts';
import { FlowCtl } from '../util/RunQueue.ts';
import { SinkRoot, SourceRoot } from './values.ts';

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

  addStaticContractProvider(hash: Hash, provider: ContractProvider) {
    this.map.set(hash.toPrimitive(), provider);
  }

  generate(
    predicate: Predicate,
    put: PutRequest | undefined,
    draft: Draft,
    flowCtl: FlowCtl,
  ): MaybePromise<void> {
    return this.getProvider(predicate.contract).generate(predicate, put, draft, flowCtl);
  }

  verify(predicate: Predicate, block: Block, flowCtl: FlowCtl): MaybePromise<boolean> {
    return this.getProvider(predicate.contract).verify(predicate, block, flowCtl);
  }

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return this.getProvider(contract).buildParams(contract, source);
  }

  buildBody(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return this.getProvider(contract).buildBody(contract, source);
  }

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return this.getProvider(contract).walkParams(contract, params, sink);
  }

  walkBody(contract: Hash, body: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return this.getProvider(contract).walkBody(contract, body, sink);
  }

  debug?(predicate: Predicate): string | undefined {
    return this.getProvider(predicate.contract).debug?.(predicate);
  }

  private getProvider(contract: Hash): ContractProvider {
    return this.map.get(contract.toPrimitive()) ?? this.base;
  }
}
