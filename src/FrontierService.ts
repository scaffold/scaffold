import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { FrontierTreeDetail } from './messages.ts';

export class FrontierService {
  constructor(private ctx: Context) {}

  create(
    inputs: InputSpec[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ): FrontierTreeDetail {
    return {
      treeWeights: this.ctx.get(FrontierService2).mergeTreeWeights(
        inputs,
        frontierVote,
      ),
      frontierVoteOutputIdxs: [],
      frontierVoteOutputMask: new Uint8Array(0),
      frontierVoteOutputCount: 0,
      subtreeOutputCount: 0,

      consumedInputsRoot: { branches: [] },
      producedOutputsRoot: { branches: [] },
    };
  }
}
