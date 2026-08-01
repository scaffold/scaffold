import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ContractProvider } from './Contract.ts';
import { MissingContractProvider } from './MissingContractProvider.ts';
import { Block, Draft, DraftPayload, Predicate } from '../graph/types.ts';

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
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.getProvider(predicate).generate(predicate, draft, signal);
  }

  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.getProvider(predicate).verify(predicate, block, signal);
  }

  debugName?(predicate: Predicate): string | undefined {
    return this.getProvider(predicate).debugName?.(predicate);
  }

  private getProvider(predicate: Predicate): ContractProvider {
    return this.map.get(predicate.contract.toPrimitive()) ?? this.base;
  }
}
