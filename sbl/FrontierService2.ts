import { BlockFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import BlockService from '~/sbl/BlockService.ts';
import { frontierHash } from '~/sbl/constants.ts';
import { InputSpec } from '~/sbl/BlockBuilder.ts';
import WeightService from '~/sbl/WeightService.ts';

const targLevel = 0;

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
    if (inputs.length === 0) {
      // TODO: Choose a frontier at random; ZERO_HASH means that it can never be merged
      return ZERO_HASH;
    }

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

    const frontierLevel = frontierInputs !== undefined
      ? frontierInputs[0].block.frontierParams.level + 1
      : 0;

    // debugger;

    // TODO: Reverse this arr
    const voteChain = [ZERO_HASH];
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
          console.error(inputs);
          throw new Error(`Unconnected inputs!`);
        }
        if (next.frontierParams.level < frontierLevel) {
          throw new Error(
            `Level ${next.frontierParams.level} < ${frontierLevel}`,
          );
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
      let bestScore: bigint | undefined;
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
