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

export default class FrontierService2 {
  constructor(private ctx: Context) {}

  // Find the block that is a merkle root of every input
  // TODO: How should we handle refs here?
  public getBlockVote(inputs: InputSpec[]): BlockFact | undefined {
    // Trace each input up (towards the frontier output), then east, towards the frontier voters, until we find a single block that includes them all. If we stop without getting a frontier, we can make one
    // TODO: Is this really the right way to do it? Maybe we should start with choosing inputs from a specific frontier?

    return;

    if (inputs.length === 0) {
      return;
    } else if (inputs.length === 1) {
      return inputs[0].block;
    }

    const nextDescendant = (block: BlockFact) => {
      let bestScore: bigint;
      let bestDescendant: BlockFact | undefined;
      for (const claim of block.outputClaims[block.frontierOutputIdx]) {
        const score = this.ctx.get(WeightService).getCanonicality(claim.block);
        if (bestDescendant === undefined || score > bestScore!) {
          bestScore = score;
          bestDescendant = claim.block;
        }
      }
      for (const voter of block.frontierVoters) {
        const score = this.ctx.get(WeightService).getCanonicality(voter);
        if (bestDescendant === undefined || score > bestScore!) {
          bestScore = score;
          bestDescendant = voter;
        }
      }
      return bestDescendant;
    };

    const cmp = (a: BlockFact, b: BlockFact) =>
      b.frontierParams.level - a.frontierParams.level ||
      (this.ctx.get(BlockService).get(b.frontier_vote, false)?.frontierParams
          .level ?? Infinity) -
        (this.ctx.get(BlockService).get(a.frontier_vote, false)?.frontierParams
          .level ?? Infinity) ||
      Hash.compare(b.hash, a.hash);
    const trace: BlockFact[] = inputs
      .map((x) => x.block)
      .toSorted(cmp)
      .filter((x, idx, arr) => idx === 0 || x !== arr[idx - 1]);

    while (trace.length > 1) {
      console.log(
        `Before:`,
        trace
          .map((x) => x.frontierParams.level + ':' + x.hash.toHex())
          .join(', '),
      );

      // Get the trace with the lowest frontier level
      const insert = this.nextTraceEntry(trace.pop()!);
      const idx = search(trace, (x) => cmp(insert, x) <= 0);
      if (insert !== trace[idx]) {
        trace.splice(idx, 0, insert);
      }

      console.log(
        `After:`,
        trace
          .map((x) => x.frontierParams.level + ':' + x.hash.toHex())
          .join(', '),
      );

      if (DEBUG) {
        for (let i = 1; i < trace.length; i++) {
          assert(cmp(trace[i - 1], trace[i]) < 0);
        }
      }
    }

    return trace[0];
  }

  private getBestParent(block: BlockFact) {
    let bestScore: bigint;
    let bestDescendant: BlockFact | undefined;
    for (const claim of block.outputClaims[block.frontierOutputIdx]) {
      const score = this.ctx.get(WeightService).getCanonicality(claim.block);
      if (bestDescendant === undefined || score > bestScore!) {
        bestScore = score;
        bestDescendant = claim.block;
      }
    }
    return bestDescendant;
  }

  private nextTraceEntry(block: BlockFact) {
    const bestParent = this.getBestParent(block);
    if (bestParent !== undefined) {
      return bestParent;
    }

    const vote = this.ctx.get(BlockService).get(block.frontier_vote, false);
    if (vote === undefined) {
      throw new Error(`Unconnected inputs!`);
    }

    return vote;
  }
}
