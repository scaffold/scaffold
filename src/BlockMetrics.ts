import { OutputClaim, ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { WeightService } from './WeightService.ts';
import { frontierHash } from './hashes.ts';
import { Hash } from './util/Hash.ts';
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
  charityOutput: bigint;
  workOutput: bigint;

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
      charityOutput: (block) =>
        block.outputs.reduce(
          (acc, cur) =>
            Hash.equals(cur.verifier.contractHash, frontierHash) ? acc + cur.amount : acc,
          0n,
        ),
      workOutput: (block) =>
        block.outputs.reduce(
          (acc, cur) =>
            Hash.equals(cur.verifier.contractHash, frontierHash) ? acc : acc + cur.amount,
          0n,
        ),

      selfWeight: (block) => this.ctx.get(WeightService).getSelfWeight(block).min,

      voterWeight: (block) => {
        const res = [0n];

        for (const voter of this.uniqueVoters(block.children)) {
          for (let i = 0; i < voter.treeWeights.length; i++) {
            res[i] ??= 0n;
            res[i] += voter.treeWeights[i];
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
        for (const squasher of block.squashers) {
          const weight = this.get(squasher, 'totalWeight');
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
        (block.parentBlock !== undefined &&
            block.parentBlock !== ZERO_BLOCK
          ? this.get(block.parentBlock, 'totalPenalty')
          : 0n),

      canonicality: (block) => this.get(block, 'totalWeight') - this.get(block, 'totalPenalty'),
    });
  }

  private treeChildrenSum(
    block: BlockFact,
    extractor: (child: BlockFact) => bigint,
  ) {
    let res = 0n;

    for (const squash of block.squashes) {
      const squashBlock = this.ctx.get(BlockService).get(squash.blockHash, false);
      if (squashBlock !== undefined) {
        res += extractor(squashBlock);
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
    Simply filter by blocks who have no squashers also in the voter set
    Parents at level L eliminate their children from the voter set, and a missing child eliminates ALL voters with level >= L-2, since they might be a grandchild
    */

    return voters.filter((x) => !x.squashers.some((squasher) => voters.includes(squasher)));

    /*
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
    */
  }
}
