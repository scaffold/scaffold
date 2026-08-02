import { Context } from '../../Context.ts';
import { MaybePromise } from '../../util/MaybePromise.ts';
import { ContractProvider } from '.././ContractProvider.ts';
import { Block, Draft, Predicate } from '../../graph/types.ts';
import { GenerationEnv } from './GenerationEnv.ts';
import { VerificationEnv } from './VerificationEnv.ts';
import { Contract } from './Contract.ts';
import { FlowCtl } from '../../util/RunQueue.ts';

export class EnvContractProvider implements ContractProvider {
  constructor(private ctx: Context, private contract: Contract) {}

  async generate(
    predicate: Predicate,
    draft: Draft,
    flowCtl: FlowCtl,
  ) {
    const env = new GenerationEnv(this.ctx, predicate, draft, flowCtl);
    await this.contract.run(env, flowCtl);
    env.finalize();
  }

  async verify(
    predicate: Predicate,
    block: Block,
    flowCtl: FlowCtl,
  ) {
    const env = new VerificationEnv(this.ctx, predicate, block, flowCtl);
    await this.contract.run(env, flowCtl);
    env.finalize();
  }

  debugName?(predicate: Predicate): string | undefined {
    return this.contract.debug?.(predicate.params, this.ctx);
  }
}
