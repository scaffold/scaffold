import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ContractProvider } from './ContractProvider.ts';
import { MissingContractProvider } from './MissingContractProvider.ts';
import { Block, Draft, DraftPayload, Predicate } from '../graph/types.ts';
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

  generate(predicate: Predicate, draft: Draft, flowCtl: FlowCtl): MaybePromise<void> {
    return this.getProvider(predicate.contract).generate(predicate, draft, flowCtl);
  }

  verify(predicate: Predicate, block: Block, flowCtl: FlowCtl): MaybePromise<void> {
    return this.getProvider(predicate.contract).verify(predicate, block, flowCtl);
  }

  buildParams(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return this.getProvider(contract).buildParams(contract, source);
  }

  buildData(contract: Hash, source: SourceRoot): MaybePromise<Uint8Array> {
    return this.getProvider(contract).buildData(contract, source);
  }

  walkParams(contract: Hash, params: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return this.getProvider(contract).walkParams(contract, params, sink);
  }

  walkData(contract: Hash, data: Uint8Array, sink: SinkRoot): MaybePromise<void> {
    return this.getProvider(contract).walkData(contract, data, sink);
  }

  debug?(predicate: Predicate): string | undefined {
    return this.getProvider(predicate.contract).debug?.(predicate);
  }

  private getProvider(contract: Hash): ContractProvider {
    return this.map.get(contract.toPrimitive()) ?? this.base;
  }
}
