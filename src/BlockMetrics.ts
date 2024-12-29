import { OutputClaim, ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { WeightService } from './WeightService.ts';
import { MetricManager } from './util/MetricManager.ts';

/*
Unique ancestors (inputs) of B:
  Tree children & tree children's tree children, recursively
  Frontier vote & frontier vote's unique ancestors
  Equivalent to X and the tree children of X, for X as every link in the frontier chain of B, including B.

Unique descendants (output claims):
  X and all recursive voters of X, for X as every parent of B, including B.
  How do we figure out the unique subset of voters (since a voter's tree weight could include another voter)
    If A is a tree child of B, then B's vote chain must include A's vote
    This might be easier than finding a mergeable subset
    Simply filter by blocks who have no parents also in the voter set
    Parents at level L eliminate their children from the voter set, and a missing child eliminates ALL voters with level >= L-2, since they might be a grandchild

In general, if a parent is WORSE by weight than its 2 children, don't even consider it as a valid block
  It might become valid in the future if stuff is built upon it
*/

type Metrics = {
  selfWeight: bigint;
  voterWeight: bigint[];
  totalWeight: bigint;

  selfPenalty: bigint;
  treePenalty: bigint;
  totalPenalty: bigint;

  canonicality: bigint;
};

export class BlockMetrics extends MetricManager<BlockFact, Metrics> {
  constructor(private ctx: Context) {
    super({
      selfWeight: (block) => this.ctx.get(WeightService).getSelfWeight(block).min,

      voterWeight: (block) => {
        const res = [0n];

        for (const voter of this.uniqueVoters(block.frontierVoters)) {
          for (let i = 0; i < voter.frontierDetail.treeWeights.length; i++) {
            res[i] ??= 0n;
            res[i] += voter.frontierDetail.treeWeights[i];
          }

          res[0] += this.get(voter, 'selfWeight');

          const sub = this.get(voter, 'voterWeight');
          for (let i = 0; i < sub.length; i++) {
            const dst = i ? i - 1 : 0;
            res[dst] ??= 0n;
            res[dst] += sub[i];
          }
        }

        return res;
      },

      totalWeight: (block) => {
        let maxParentWeight = 0n;
        for (const claim of block.outputClaims[block.frontierOutputIdx]) {
          const weight = this.get(claim.block, 'totalWeight');
          if (weight > maxParentWeight) {
            maxParentWeight = weight;
          }
        }
        return this.get(block, 'selfWeight') + maxParentWeight +
          this.get(block, 'voterWeight')[0];
      },

      selfPenalty: (block) => {
        let sum = 0n;

        for (const input of block.inputs) {
          const claims = this.ctx.get(BlockService).getClaims(input);
          const overpayment = this.get(block, 'selfWeight') -
            this.getBestClaimWeight(claims);
          sum += this.ctx.config.getOverpaymentPenalty(overpayment);
        }

        return sum;
      },

      treePenalty: (block) =>
        this.get(block, 'selfPenalty') +
        this.treeChildrenSum(block, (child) => this.get(child, 'treePenalty')),

      totalPenalty: (block) =>
        this.get(block, 'treePenalty') +
        (block.frontierVoteBlock !== undefined &&
            block.frontierVoteBlock !== ZERO_BLOCK
          ? this.get(block.frontierVoteBlock, 'totalPenalty')
          : 0n),

      canonicality: (block) => this.get(block, 'totalWeight') - this.get(block, 'totalPenalty'),
    });
  }

  private treeChildrenSum(
    block: BlockFact,
    extractor: (child: BlockFact) => bigint,
  ) {
    let res = 0n;

    for (const input of block.inputs) {
      const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
      if (
        inputBlock !== undefined &&
        input.outputIdx === inputBlock.frontierOutputIdx
      ) {
        res += extractor(inputBlock);
      }
    }

    return res;
  }

  private getBestClaimWeight(claims: OutputClaim[]) {
    return claims
      .map((x) => this.get(x.block, 'selfWeight'))
      .reduce((x, y) => x < y ? x : y);
  }

  private uniqueVoters(voters: BlockFact[]) {
    /*
    Simply filter by blocks who have no parents also in the voter set
    Parents at level L eliminate their children from the voter set, and a missing child eliminates ALL voters with level >= L-2, since they might be a grandchild
    */

    const isValidParent = (block: BlockFact) => true;
    voters = voters.filter(isValidParent);

    let maxMissingChildLevel = 0;
    for (const voter of voters) {
      if (
        voter.frontierParams.level > maxMissingChildLevel &&
        this.treeChildrenSum(voter, () => 1n) !== 2n
      ) {
        maxMissingChildLevel = voter.frontierParams.level;
      }
    }
    const levelThreshold = maxMissingChildLevel - 1;

    return voters.filter((block) =>
      block.frontierParams.level >= levelThreshold &&
      block.outputClaims[block.frontierOutputIdx].every((claim) => !voters.includes(claim.block))
    );
  }
}
