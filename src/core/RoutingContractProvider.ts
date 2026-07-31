import { Context } from '../Context.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { ContractProvider } from './Contract.ts';
import { MissingContractProvider } from './MissingContractProvider.ts';
import { Block, DraftPayload, Predicate } from './types.ts';

export class RoutingContractProvider implements ContractProvider {
  private map = new Map<HashPrimitive, ContractProvider>();

  constructor(
    _ctx: Context,
    contracts: { name: Hash; provider: ContractProvider }[],
    private base: ContractProvider = new MissingContractProvider(),
  ) {
    for (const { name, provider } of contracts) {
      this.map.set(name.toPrimitive(), provider);
    }
  }

  generate(
    predicate: Predicate,
    update: (draftPayload: DraftPayload) => void,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.getProvider(predicate).generate(predicate, update, signal);
  }

  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.getProvider(predicate).verify(predicate, block, signal);
  }

  private getProvider(predicate: Predicate): ContractProvider {
    return this.map.get(predicate.contract.toPrimitive()) ?? this.base;
  }
}
