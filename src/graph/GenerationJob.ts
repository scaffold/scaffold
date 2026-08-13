import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { Hash } from '../util/Hash.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { CancelError, FlowCtl, Job } from '../peer/ExecutionQueue.ts';
import { Draft, Predicate } from '../graph/types.ts';
import { SIGNATURE_CONTRACT } from '../contract/static/Signature.ts';
import { PutRequest } from '../contract/ContractProvider.ts';

export class GenerationJob implements Job {
  private draft?: Draft;

  constructor(
    private ctx: Context,
    private predicate: Predicate,
    private put?: PutRequest,
    private onDraft?: (draft: Draft) => void,
  ) {}

  profit(): bigint {
    return this.draft !== undefined ? -this.draft.ioDelta : 0n;
  }

  priority(): number {
    // TODO: This needs to reflect the expected profit of the job, whether it's running or not.
    // Before a job starts, we need to estimate the profit
    // While a job is running, we need to estimate the profit
    // While a job isn't running, we don't hold a draft. So we'll have to estimate the profit without it.

    return Number(this.profit());
  }

  async run(ctl: FlowCtl): Promise<void> {
    assert(this.draft === undefined);
    this.draft = this.ctx.get(DraftStore).create();
    if (this.onDraft !== undefined) this.onDraft(this.draft);
    try {
      await this.ctx.get(this.ctx.config.contractPlugin)
        .generate(this.predicate, this.put, this.draft, ctl);

      if (this.draft.ioDelta > 0n) {
        // Not profitable
        this.ctx.get(DraftStore).cancel(this.draft);
      } else if (Hash.equals(this.predicate.contract, SIGNATURE_CONTRACT)) {
        // The signature contract stores as a store of value; there's no need to immediately publish the claiming block.
        this.ctx.get(DraftStore).lock(this.draft);
      } else {
        this.ctx.get(DraftStore).build(this.draft);
      }
    } catch (err) {
      if (!(err instanceof CancelError)) {
        this.ctx.logger('generation_job')?.error('generateFailed', {
          contract: this.predicate.contract.toHex(),
          err,
        });
      }

      this.ctx.get(DraftStore).cancel(this.draft);

      throw err;
    } finally {
      this.draft = undefined;
    }
  }
}
