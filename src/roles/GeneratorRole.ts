import { Context } from '../Context.ts';
import { assert } from '../util/functional.ts';
import { Hash } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import { mapPut } from '../util/map.ts';
import { BlockStore } from '../graph/BlockStore.ts';
import { DraftStore } from '../graph/DraftStore.ts';
import { CancelError, ExecutionQueue, FlowCtl, Job } from '../peer/ExecutionQueue.ts';
import { Block, Draft, Predicate } from '../graph/types.ts';
import { SIGNATURE_CONTRACT } from '../contract/static/Signature.ts';
import { OutputIndex } from '../graph/OutputIndex.ts';

export class GeneratorRole implements Disposable {
  private disposeController = new AbortController();

  constructor(private ctx: Context) {}

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  run() {
    // Make sure the OutputIndex's onIngest is registered first.
    // This is necessary so incoming outputs are first available to things blocking on a specific output (like ContractEnv.claim), then secondly launch a generation job.
    this.ctx.get(OutputIndex);

    this.ctx.get(BlockStore).onIngest(
      (block) => this.onIngest(block),
      this.disposeController.signal,
    );
  }

  private onIngest(block: Block) {
    for (let i = 0; i < block.payload.outputs.length; i++) {
      this.trigger(block, i);
    }
  }

  private trigger(block: Block, outputIdx: number) {
    // Skip self-claimed outputs
    if (block.payload.claims.includes(BigInt(outputIdx))) return;

    // Skip otherwise claimed outputs
    if (block.resolvingOutputs.get(BigInt(outputIdx))?.length) return;

    const output = block.payload.outputs[outputIdx];

    const job = new GenerationJob(this.ctx, output);
    this.ctx.get(ExecutionQueue).run(job)
      .then(() => this.ctx.get(ExecutionQueue).remove(job));
  }
}

class GenerationJob implements Job {
  private draft?: Draft;

  constructor(private ctx: Context, private predicate: Predicate) {}

  priority(): number {
    // TODO: This needs to reflect the expected profit of the job, whether it's running or not.
    // Before a job starts, we need to estimate the profit
    // While a job is running, we need to estimate the profit
    // While a job isn't running, we don't hold a draft. So we'll have to estimate the profit without it.

    return 0;
  }

  async run(ctl: FlowCtl): Promise<void> {
    assert(this.draft === undefined);
    this.draft = this.ctx.get(DraftStore).create();
    try {
      await this.ctx.get(this.ctx.config.contractPlugin).generate(this.predicate, this.draft, ctl);

      if (Hash.equals(this.predicate.contract, SIGNATURE_CONTRACT)) {
        // The signature contract stores as a store of value; there's no need to immediately publish the claiming block.
        this.ctx.get(DraftStore).lock(this.draft);
      } else {
        this.ctx.get(DraftStore).build(this.draft);
      }
    } catch (err) {
      if (!(err instanceof CancelError)) {
        console.error(err);
      }

      this.ctx.get(DraftStore).cancel(this.draft);
    } finally {
      this.draft = undefined;
    }
  }
}
