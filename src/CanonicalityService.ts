import { assert } from '@std/assert/assert';
import { AvailableOutputManager } from './AvailableOutputManager.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';

// An input should be in the AvailableOutputManager if the output is canonical and there's no canonical claims.

export class CanonicalityService {
  constructor(private ctx: Context) {}

  onCanonical(block: BlockFact) {
    assert(block.isCanonical);

    for (const input of block.inputs) {
      const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
      if (inputBlock !== undefined && inputBlock.isCanonical) {
        this.ctx.get(AvailableOutputManager).remove(
          inputBlock.outputs[input.outputIdx].verifier,
          (x) => x.block === inputBlock && x.outputIdx === input.outputIdx,
        );
      }
    }

    for (let i = 0; i < block.outputs.length; i++) {
      const output = block.outputs[i];
      const claims = block.outputClaims[i];
      if (!claims.some((x) => x.block.isCanonical)) {
        this.ctx.get(AvailableOutputManager).insert(
          output.verifier,
          { block, outputIdx: i, amount: output.amount },
        );
      }

      // TODO
      // this.ctx.get(GenerationService).ensureRunning(output.verifier);
    }
  }

  offCanonical(block: BlockFact) {
    assert(!block.isCanonical);

    for (const output of block.outputs) {
      this.ctx.get(AvailableOutputManager).remove(output.verifier, (x) => x.block === block);
    }

    for (const input of block.inputs) {
      const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
      if (
        inputBlock !== undefined && inputBlock.isCanonical &&
        !inputBlock.outputClaims[input.outputIdx].some((x) => x.block.isCanonical)
      ) {
        const output = inputBlock.outputs[input.outputIdx];
        this.ctx.get(AvailableOutputManager).insert(
          output.verifier,
          { block: inputBlock, outputIdx: input.outputIdx, amount: output.amount },
        );

        // TODO
        // this.ctx.get(GenerationService).ensureRunning(output.verifier);
      }
    }

    // TODO: Send usurper
    // const { usurper } = this.ctx.get(WeightService).getCanonicality(block);
    // if (usurper !== undefined) {
    //   this.ctx.get(FactEmitter).notify(usurper.block);
    // }
  }
}
