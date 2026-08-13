import { Context } from '../Context.ts';
import { BlockStore } from '../graph/BlockStore.ts';
import { ExecutionQueue } from '../peer/ExecutionQueue.ts';
import { Block } from '../graph/types.ts';
import { OutputIndex } from '../graph/OutputIndex.ts';
import { GenerationJob } from '../graph/GenerationJob.ts';

export class GeneratorRole implements Disposable {
  private disposeController = new AbortController();

  constructor(private ctx: Context) {
    // Make sure the OutputIndex's onIngest is registered first.
    // This is necessary so incoming outputs are first available to things blocking on a specific output (like ContractEnv.claim), then secondly launch a generation job.
    this.ctx.get(OutputIndex);

    this.ctx.get(BlockStore).onIngest(
      (block) => this.ingestBlock(block),
      this.disposeController.signal,
    );
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  private ingestBlock(block: Block) {
    for (let i = 0; i < block.payload.outputs.length; i++) {
      this.trigger(block, i);
    }
  }

  private async trigger(block: Block, outputIdx: number) {
    // Skip self-claimed outputs
    if (block.payload.claims.includes(BigInt(outputIdx))) return;

    // Skip otherwise claimed outputs
    if (block.resolvingOutputs.get(BigInt(outputIdx))?.length) return;

    const output = block.payload.outputs[outputIdx];

    const job = new GenerationJob(this.ctx, output);
    try {
      await this.ctx.get(ExecutionQueue).run(job);
    } catch (err) {
      this.ctx.logger('generator')?.error('generationFailed', {
        block: block.hash.toHex(),
        outputIdx,
        err,
      });
    } finally {
      this.ctx.get(ExecutionQueue).remove(job);
    }
  }
}
