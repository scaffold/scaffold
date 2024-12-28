import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { FrontierTreeDetail } from './messages.ts';
import { EMPTY_ARR } from './util/buffer.ts';

export class FrontierService {
  constructor(private ctx: Context) {}

  create(
    inputs: InputSpec[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ): FrontierTreeDetail {
    const treeChildren = inputs.filter((input) =>
      input.block.frontierOutputIdx === input.outputIdx
    );

    return {
      treeWeights: this.ctx.get(FrontierService2)
        .mergeTreeWeights(inputs, frontierVote),

      frontierVoteOutputCount: this.getOutputCount(frontierVote),
      subtreeSpentIdxs: [],
      subtreeOutputCount: 0,

      consumedInputsRoot: { branches: [] },
      producedOutputsRoot: { branches: [] },
    };
  }

  private getOutputCount(block: BlockFact | typeof ZERO_BLOCK) {
    if (block === ZERO_BLOCK) {
      return 0;
    }

    return block.frontierDetail.frontierVoteOutputCount -
      block.frontierDetail.subtreeSpentIdxs.length +
      block.frontierDetail.subtreeOutputCount +
      block.outputs.length;
  }
}
