import { Context } from '../Context.ts';
import { arrEquals } from '../util/buffer.ts';
import { Hash } from '../util/Hash.ts';
import { BlockStore } from './BlockStore.ts';
import { Block, Output, OutputResolverType, Predicate, ResolvingClaim } from './types.ts';

export interface OutputLocation {
  producer: Block;
  outputIndex: number;
  output: Output;
  claims: ResolvingClaim[];
}

export class OutputIndex implements Disposable {
  private disposeController = new AbortController();

  constructor(private ctx: Context) {
    for (const block of ctx.get(BlockStore).getAll()) this.updateIndex(block);
    ctx.get(BlockStore).onIngest((block) => this.updateIndex(block), this.disposeController.signal);
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  onOutput(predicate: Predicate, cb: (output: OutputLocation) => void, signal: AbortSignal) {
    // TODO: Hit index for faster lookups

    if (signal.aborted) return;

    const checkBlock = (block: Block) => {
      for (let i = 0; i < block.payload.outputs.length; i++) {
        const output = block.payload.outputs[i];
        if (!Hash.equals(output.contract, predicate.contract)) continue;
        if (!arrEquals(output.params, predicate.params)) continue;

        const claims = (block.resolvingOutputs.get(BigInt(i)) ?? [])
          .filter((x) => x.type === OutputResolverType.Claim);

        cb({ producer: block, outputIndex: i, output, claims });
        if (signal.aborted) return;
      }
    };

    for (const block of this.ctx.get(BlockStore).getAll()) {
      checkBlock(block);
      if (signal.aborted) return;
    }

    this.ctx.get(BlockStore).onIngest((block) => checkBlock(block), signal);
  }

  private updateIndex(block: Block) {
    // TODO: Update index
  }
}
