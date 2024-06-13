import { OutputClaim } from './BlockMeta.ts';
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
    If A is a tree child of B, then
    This might be easier than finding a mergeable subset
*/

type Metrics = {
  selfWeight: bigint;

  selfPenalty: bigint;
  treePenalty: bigint;
  totalPenalty: bigint;
};

export class BlockMetrics extends MetricManager<BlockFact, Metrics> {
  constructor(private ctx: Context) {
    super({
      selfWeight: (block) =>
        this.ctx.get(WeightService).getSelfWeight(block).min,

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
        (block.frontierVoteBlock !== undefined
          ? this.get(block.frontierVoteBlock, 'totalPenalty')
          : 0n),
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
}
