import { BlockFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import BlockService from '~/sbl/BlockService.ts';
import { frontierHash } from '~/sbl/constants.ts';
import { FrontierTreeParams } from '~/sbl/messages.ts';
import { InputSpec } from '~/sbl/BlockBuilder.ts';
import { lowerBound, search } from '~/sbl/util/sorted.ts';
import WeightService from '~/sbl/WeightService.ts';
import { assert } from '~/sbl/util/functional.ts';

const DEBUG = true;
const targLevel = 0;

interface TraceEntry {
  block: BlockFact;
  frontierRoot?: BlockFact;
}

export default class FrontierService2 {
  constructor(private ctx: Context) {}

  public mergeFrontierVotes(a: BlockFact, b: BlockFact) {
    if (a.frontierParams.level > b.frontierParams.level) {
      const t = a;
      a = b;
      b = t;
    }

    let it = a;
    while (it.frontierParams.level < b.frontierParams.level) {
      const vote = this.ctx.get(BlockService).get(it.frontier_vote);
      if (vote === undefined) {
        return;
      }
      it = vote;
    }

    if (it === b) {
      return a;
    }
  }

  // TODO: How should we handle refs here?
  public getBlockVote(inputs: InputSpec[]): BlockFact | undefined {
    // Trace each input up (towards the frontier output), then east, towards the frontier voters, until we find a single block that includes them all. If we stop without getting a frontier, we can make one
    // TODO: Is this really the right way to do it? Maybe we should start with choosing inputs from a specific frontier?

    if (inputs.length === 0) {
      return;
    }

    debugger;

    const roots = inputs
      .map((x) => this.getTreeRoot(x.block))
      .sort((a, b) =>
        a.frontierParams.level - b.frontierParams.level ||
        (this.ctx.get(BlockService).get(a.frontier_vote, false)
            ?.frontierParams.level ?? Infinity) -
          (this.ctx.get(BlockService).get(b.frontier_vote, false)
            ?.frontierParams.level ?? Infinity)
      );

    let ptr = roots[0];
    for (let i = 1; i < roots.length; i++) {
      while (ptr !== roots[i]) {
        const next = this.ctx.get(BlockService).get(ptr.frontier_vote, false);
        if (next === undefined) {
          throw new Error(`Unconnected inputs!`);
        }

        ptr = next;
      }
    }

    ptr = roots[0];
    while (ptr.frontierParams.level > targLevel) {
      const voter = this.getBestVoter(ptr);
      if (voter === undefined) {
        return ptr;
      } else {
        ptr = voter;
      }
    }
    return ptr;
  }

  private getTreeRoot(block: BlockFact) {
    while (true) {
      let bestScore: bigint;
      let bestDescendant: BlockFact | undefined;
      for (const claim of block.outputClaims[block.frontierOutputIdx]) {
        const score = this.ctx.get(WeightService).getCanonicality(claim.block);
        if (bestDescendant === undefined || score > bestScore!) {
          bestScore = score;
          bestDescendant = claim.block;
        }
      }

      if (bestDescendant !== undefined) {
        block = bestDescendant;
      } else {
        return block;
      }
    }
  }

  private getBestVoter(block: BlockFact) {
    let bestScore: bigint;
    let bestDescendant: BlockFact | undefined;
    for (const voter of block.frontierVoters) {
      const score = this.ctx.get(WeightService).getCanonicality(voter);
      if (bestDescendant === undefined || score > bestScore!) {
        bestScore = score;
        bestDescendant = voter;
      }
    }

    return bestDescendant;
  }
}
