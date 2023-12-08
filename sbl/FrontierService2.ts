import { BlockFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import BlockService from '~/sbl/BlockService.ts';
import { frontierHash } from '~/sbl/constants.ts';
import { FrontierTreeParams } from '~/sbl/messages.ts';
import { InputSpec } from '~/sbl/BlockBuilder.ts';
import { lowerBound } from '~/sbl/util/sorted.ts';
import WeightService from '~/sbl/WeightService.ts';

export default class FrontierService2 {
  constructor(private ctx: Context) {}

  // TODO: How should we handle refs here?
  public getBlockVote(inputs: InputSpec[]): BlockFact | undefined {
    // Trace each input up (towards the frontier output), then east, towards the frontier voters, until we find a single block that includes them all. If we stop without getting a frontier, we can make one
    // TODO: Is this really the right way to do it? Maybe we should start with choosing inputs from a specific frontier?

    if (inputs.length === 0) {
      return;
    }

    const heuristic = (block: BlockFact) =>
      block.outputClaims[block.frontierOutputIdx].some((claim) =>
          // this.ctx.get(WeightService).isCanonical(claim.block)
          true
        )
        ? -block.frontierParams.level
        : block.frontierParams.level;

    // let trace = inputs.toSorted((a, b) =>
    //   heuristic(a.block) - heuristic(b.block)
    // );
    // while (trace.length > 1) {
    //   const block = trace.pop()!.block;

    //   break;
    // }

    // return trace[0].block;
  }
}
