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
  public getBlockVote(inputs: InputSpec[]): Hash {
    // Trace each input up (towards the frontier output), then east, towards the frontier voters, until we find a single block that includes them all. If we stop without getting a frontier, we can make one
    // TODO: Is this really the right way to do it? Maybe we should start with choosing inputs from a specific frontier?

    if (inputs.length === 0) {
      // TODO: Choose a frontier at random; ZERO_HASH means that it can never be merged
      return ZERO_HASH;
    }

    /*
    Satisfying a non-frontier input involves:
    - The input block is a descendant of the created block, via a chain of frontier hashes, then a chain of frontier input hashes.
    - Adding an input means the frontier hash can ONLY move to a voter of it (a descendant via frontier_vote).

    The frontier inputs are fundamentally different than other inputs, because they aren't descendants of the frontier vote. The chain goes like this:
      createdBlock.frontierInput[0].frontier_vote === createdBlock.frontierInput[1].hash
      createdBlock.frontierInput[1].frontier_vote === createdBlock.frontier_vote
      frontierChain = (createdBlock, createdBlock.frontier_vote, createdBlock.frontier_vote.frontier_vote, ...)
      allowedInputBlocks = (frontierChain, frontierChain.frontierInput[*], frontierChain.frontierInput[*].frontierInput[*], ...)

    If X is not canonical, then (1) blocks whose frontier vote is X, and (2) blocks who input X, are not canonical.
    - All inputs must be canonical


    Get all roots
    The frontier vote is a descendant of all roots
    The frontier vote is a descendant of the youngest root
    The frontier vote is a descendant of the frontier_votes of all frontier inputs that do not vote for another fontier input
    The frontier vote is a
    */

    const { frontierInputs, normalInputs } = Object.groupBy(
      inputs,
      (input) =>
        Hash.equals(
            input.block.outputs[input.outputIdx].verifier.contract_hash,
            frontierHash,
          )
          ? 'frontierInputs'
          : 'normalInputs',
    );

    // TODO: Reverse this arr
    let voteChain = [ZERO_HASH];
    const ensureInChain = (vote: Hash) => {
      if (frontierInputs !== undefined) {
        while (true) {
          const fi = frontierInputs.find((input) =>
            Hash.equals(input.block.hash, vote)
          );
          if (fi !== undefined) {
            vote = fi.block.frontier_vote;
          } else {
            break;
          }
        }
      }

      if (voteChain.some((v) => Hash.equals(v, vote))) {
        return;
      }

      const idx = voteChain.length;
      const last = voteChain[idx - 1];

      let ptr = vote;
      do {
        const next = this.ctx.get(BlockService).get(ptr, false);
        if (next === undefined) {
          throw new Error(`Unconnected inputs!`);
        }
        voteChain.splice(idx, 0, ptr);
        ptr = next.frontier_vote;
      } while (!Hash.equals(ptr, last));
    };

    if (frontierInputs !== undefined) {
      for (const input of frontierInputs) {
        ensureInChain(input.block.frontier_vote);
      }
    }

    if (normalInputs !== undefined) {
      for (const input of normalInputs) {
        ensureInChain(this.getTreeRoot(input.block).hash);
      }
    }

    return voteChain[voteChain.length - 1];
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
}
