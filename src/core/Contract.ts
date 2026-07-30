import { Context } from '../Context.ts';
import { Block, DraftPayload, Predicate } from './types.ts';

export interface ContractProvider {
  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): Promise<void>;

  generate(
    predicate: Predicate,
    update: (draftPayload: DraftPayload) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ContractPlugin {
  new (ctx: Context): ContractProvider;
}
