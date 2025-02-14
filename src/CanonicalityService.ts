import { assert } from '@std/assert/assert';
import { AvailableOutputManager } from './AvailableOutputManager.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { bin2hex } from './util/hex.ts';
import { QaService } from './QaService.ts';
import { RoutingService } from './RoutingService.ts';
import { RoutingService2 } from './RoutingService2.ts';

// An input should be in the AvailableOutputManager if the output is canonical and there's no canonical claims.

export class CanonicalityService {
  constructor(private ctx: Context) {}

  onCanonical(block: BlockFact) {
    assert(block.isCanonical);

    console.log('onCanonical', block.hash.toHex());

    for (const input of block.inputs) {
      const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
      console.log(
        'onCanonical',
        block.hash.toHex(),
        'remove',
        inputBlock !== undefined && inputBlock.isCanonical,
      );
      if (inputBlock !== undefined && inputBlock.isCanonical) {
        console.log(
          'onCanonical',
          block.hash.toHex(),
          'remove',
          inputBlock.outputs[input.outputIdx].verifier.contractHash.toHex(),
          bin2hex(inputBlock.outputs[input.outputIdx].verifier.params),
        );
        this.ctx.get(AvailableOutputManager).remove(
          inputBlock.outputs[input.outputIdx].verifier,
          (x) => x.block === inputBlock && x.outputIdx === input.outputIdx,
        );
      }
    }

    for (let i = 0; i < block.outputs.length; i++) {
      const output = block.outputs[i];
      const claims = block.outputClaims[i];
      console.log(
        'onCanonical',
        block.hash.toHex(),
        'insert',
        i,
        !claims.some((x) => x.block.isCanonical),
      );
      if (!claims.some((x) => x.block.isCanonical)) {
        console.log(
          'onCanonical',
          block.hash.toHex(),
          'insert',
          output.verifier.contractHash.toHex(),
          bin2hex(output.verifier.params),
        );
        this.ctx.get(AvailableOutputManager).insert(
          output.verifier,
          { block, outputIdx: i, amount: output.amount },
        );
      }

      // TODO
      // this.ctx.get(GenerationService).ensureRunning(output.verifier);
    }

    for (const question of this.ctx.get(QaService).getQuestions(block)) {
      for (const from of question.fact.requesting) {
        from.get(RoutingService).enqueue(block);
      }
    }
  }

  offCanonical(block: BlockFact) {
    assert(!block.isCanonical);

    console.log('offCanonical', block.hash.toHex());

    for (const output of block.outputs) {
      console.log('offCanonical', block.hash.toHex(), 'remove');
      console.log(
        'offCanonical',
        block.hash.toHex(),
        'remove',
        output.verifier.contractHash.toHex(),
        bin2hex(output.verifier.params),
      );
      this.ctx.get(AvailableOutputManager).remove(output.verifier, (x) => x.block === block);
    }

    for (const input of block.inputs) {
      const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
      console.log(
        'offCanonical',
        block.hash.toHex(),
        'insert',
        inputBlock !== undefined && inputBlock.isCanonical &&
          !inputBlock.outputClaims[input.outputIdx].some((x) => x.block.isCanonical),
      );
      if (
        inputBlock !== undefined && inputBlock.isCanonical &&
        !inputBlock.outputClaims[input.outputIdx].some((x) => x.block.isCanonical)
      ) {
        console.log(
          'offCanonical',
          block.hash.toHex(),
          'insert',
          inputBlock.outputs[input.outputIdx].verifier.contractHash.toHex(),
          bin2hex(inputBlock.outputs[input.outputIdx].verifier.params),
        );
        const output = inputBlock.outputs[input.outputIdx];
        this.ctx.get(AvailableOutputManager).insert(
          output.verifier,
          { block: inputBlock, outputIdx: input.outputIdx, amount: output.amount },
        );

        // TODO
        // this.ctx.get(GenerationService).ensureRunning(output.verifier);
      }
    }

    for (const draft of block.persistentSources) {
      // TODO: Re-publish
    }

    // TODO: Send usurper
    // const { usurper } = this.ctx.get(WeightService).getCanonicality(block);
    // if (usurper !== undefined) {
    //   this.ctx.get(FactEmitter).notify(usurper.block);
    // }
  }
}
