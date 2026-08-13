import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { Hash } from '../util/Hash.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { CancelError, FlowCtl, Job } from '../peer/ExecutionQueue.ts';
import { Block, Draft, Predicate } from '../graph/types.ts';
import { SIGNATURE_CONTRACT } from '../contract/static/Signature.ts';
import { PutRequest } from '../contract/ContractProvider.ts';

export class VerificationJob implements Job {
  constructor(
    private ctx: Context,
    private predicate: Predicate,
    private block: Block,
    private onValidity: (isValid: boolean) => void,
  ) {}

  priority(): number {
    return 0;
  }

  async run(ctl: FlowCtl): Promise<void> {
    try {
      const isValid = await this.ctx.get(this.ctx.config.contractPlugin)
        .verify(this.predicate, this.block, ctl);
      this.onValidity(isValid);
    } catch (err) {
      if (!(err instanceof CancelError)) {
        this.ctx.logger('verification')?.error('verifyFailed', {
          block: this.block.hash.toHex(),
          err,
        });
      }
    }
  }
}
