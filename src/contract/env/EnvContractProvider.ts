import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractProvider } from '.././Contract.ts';
import { Block, Draft, Predicate } from '../../graph/types.ts';
import { GenerationEnv } from './GenerationEnv.ts';
import { VerificationEnv } from './VerificationEnv.ts';
import { Contract } from './Contract.ts';

export class EnvContractProvider implements ContractProvider {
  constructor(private ctx: Context, private contract: Contract) {}

  generate(
    predicate: Predicate,
    draft: Draft,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.contract.run(new GenerationEnv(this.ctx, predicate, draft, signal), signal);
  }

  verify(
    predicate: Predicate,
    block: Block,
    signal: AbortSignal,
  ): MaybePromise<void> {
    return this.contract.run(new VerificationEnv(this.ctx, predicate, block, signal), signal);
  }

  debugName?(predicate: Predicate): string | undefined {
    return this.contract.debug?.(predicate.params, this.ctx);
  }
}
