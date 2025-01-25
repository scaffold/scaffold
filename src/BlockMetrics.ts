import { OutputClaim, ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { WeightService } from './WeightService.ts';
import { frontierHash } from './hashes.ts';
import { Verifier } from './messages.ts';
import { Hash } from './util/Hash.ts';
import { MetricManager } from './util/MetricManager.ts';
import { bigintMin } from './util/bigint.ts';

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
  selfWork: bigint;
  freeMarketOutput: bigint;
  conservativeSelfWork: bigint;

  childWeight: bigint;

  ancestorWeight: bigint;
  descendantWeight: bigint;

  conflictScore: bigint;
  isConflictWinner: boolean;
  isCanonical: boolean;
};

export class BlockMetrics extends MetricManager<BlockFact, Metrics> {
  constructor(private ctx: Context) {
    super({
      // This can only increase as we know more inputs
      selfWork: (block) => {
        let work = 1n;

        for (const input of block.inputs) {
          const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
          if (inputBlock !== undefined) {
            const output = inputBlock.outputs[input.outputIdx];
            if (this.isFreeMarketOutput(output.verifier)) {
              work += output.amount;
            }
          }
        }

        for (const output of block.outputs) {
          if (this.isFreeMarketOutput(output.verifier)) {
            work -= output.amount;
          }
        }

        return work;
      },

      freeMarketOutput: (block: BlockFact) => {
        let sum = 0n;
        for (const output of block.outputs) {
          if (this.isFreeMarketOutput(output.verifier)) {
            sum += output.amount;
          }
        }
        return sum;
      },

      conservativeSelfWork: (block: BlockFact) => {
        let minWork = this.get(block, 'selfWork');
        for (const conflict of block.conflicts.keys()) {
          minWork = bigintMin(minWork, this.get(conflict, 'selfWork'));
        }
        return minWork;
      },

      childWeight: (block: BlockFact) => {
        let weight = 0n;
        for (const child of block.children) {
          if (this.get(child, 'isConflictWinner')) {
            weight += this.get(child, 'selfWork');
            weight += this.get(child, 'childWeight');
          }
        }
        return weight;

        // if (weight !== block.childWeight) {
        //   block.childWeight = weight;

        //   if (block.parentBlock !== undefined && block.parentBlock !== ZERO_BLOCK) {
        //     this.updateChildWeight(block.parentBlock);
        //   }
        // }
      },

      // TODO: Cache this on the block, should be easy cuz it never changes.
      ancestorWeight: (block: BlockFact) => {
        let sum = 0n;
        if (block.parentBlock !== undefined && block.parentBlock !== ZERO_BLOCK) {
          sum += this.get(block.parentBlock, 'selfWork');
          sum += this.get(block.parentBlock, 'ancestorWeight');
        }
        for (const tw of block.treeWeights) {
          sum += tw;
        }
        return sum;
      },

      descendantWeight: (block: BlockFact) => {
        let sum = 0n;
        sum += this.get(block, 'childWeight');

        let bestSquasher: BlockFact | undefined;
        let bestSquashScore = 0n;

        for (const squash of block.squashers) {
          const score = this.get(squash, 'conflictScore');
          if (
            bestSquasher === undefined || score > bestSquashScore ||
            (score === bestSquashScore && Hash.compare(bestSquasher.hash, block.hash) > 0)
          ) {
            bestSquasher = squash;
            bestSquashScore = score;
          }
        }

        if (bestSquasher !== undefined) {
          sum += this.get(bestSquasher, 'selfWork');
          sum += this.get(bestSquasher, 'descendantWeight');
        }

        return sum;
      },

      conflictScore: (block: BlockFact) => {
        let sum = 0n;
        sum += this.get(block, 'conservativeSelfWork');
        sum += this.get(block, 'freeMarketOutput');
        sum += this.get(block, 'ancestorWeight');
        sum += this.get(block, 'descendantWeight');
        return sum;
      },

      isConflictWinner: (block: BlockFact) => {
        // if (block.squashers.length) {
        //   return false;
        // }

        const score = this.get(block, 'conflictScore');

        for (const conflict of block.conflicts.keys()) {
          // if (conflict.squashers.length) {
          //   continue;
          // }

          const conflictScore = this.get(conflict, 'conflictScore');
          if (
            conflictScore > score ||
            (conflictScore === score && Hash.compare(conflict.hash, block.hash) > 0)
          ) {
            return false;
          }
        }

        return true;
      },

      isCanonical: (block: BlockFact) => {
        return this.get(block, 'isConflictWinner') &&
          (block.parentBlock === undefined || block.parentBlock === ZERO_BLOCK ||
            this.get(block.parentBlock, 'isCanonical'));
      },
    });
  }

  public isFreeMarketOutput(verifier: Verifier) {
    return Hash.equals(verifier.contractHash, frontierHash);
  }
}
