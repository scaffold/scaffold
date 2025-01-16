import { BlockBuilder } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { trueHash } from './hashes.ts';
import { FrontierTreeParams } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { EMPTY_ARR } from './util/buffer.ts';

export class GraphUtilityService {
  constructor(private ctx: Context) {}

  public addBlock(
    vote: BlockFact | typeof ZERO_BLOCK | undefined,
    frontierChildren?: BlockFact[],
  ) {
    let frontierLevel: number | undefined;
    const inputs = frontierChildren?.map((child) => {
      const output = child.outputs[child.frontierOutputIdx];

      const { level } = FrontierTreeParams.decode(output.verifier.params);
      if (frontierLevel === undefined) {
        frontierLevel = level;
      } else if (frontierLevel !== level) {
        throw new Error(`Cannot add children with different levels!`);
      }

      return {
        block: child,
        outputIdx: child.frontierOutputIdx,
        amount: output.amount,
      };
    });

    const block = this.ctx.get(BlockBuilder).publishSingleDraft({
      frontierVote: vote,
      frontierLevel: frontierLevel ?? 0,
      inputs,
      outputs: [{
        verifier: { contractHash: trueHash, params: EMPTY_ARR },
        amount: 10n,
        detail: EMPTY_ARR,
      }],
    });

    const otherOutputIdx = block.outputs.findIndex((x) =>
      Hash.equals(x.verifier.contractHash, trueHash)
    );
    return Object.assign(block, { otherOutputIdx });
  }
}
