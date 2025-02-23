import { OutputClaim, ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
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

// type MeteredBlock = Pick<
//   BlockFact,
//   | 'inputs'
//   | 'outputs'
//   | 'conflicts'
//   | 'children'
//   | 'sillyName'
//   | 'parentBlock'
//   | 'squashes'
//   | 'treeWeights'
//   | 'squashers'
// >;
type MeteredBlock = BlockFact;

type Metrics = {
  selfWork: bigint;
  freeMarketOutput: bigint;
  conservativeSelfWork: bigint;

  childWeight: bigint;
  childWeight1: bigint;
  childWeights2: bigint[];

  ancestorWeight: bigint;
  descendantWeight: bigint;

  conflictScore: bigint;
  isConflictWinner: boolean;
  isCanonical: boolean;
};

export class BlockMetrics extends MetricManager<MeteredBlock, Metrics> {
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

      freeMarketOutput: (block: MeteredBlock) => {
        let sum = 0n;
        for (const output of block.outputs) {
          if (this.isFreeMarketOutput(output.verifier)) {
            sum += output.amount;
          }
        }
        return sum;
      },

      conservativeSelfWork: (block: MeteredBlock) => {
        let minWork = this.get(block, 'selfWork');
        for (const conflict of block.conflicts.keys()) {
          minWork = bigintMin(minWork, this.get(conflict, 'selfWork'));
        }
        return minWork;
      },

      childWeight: (block: MeteredBlock) => {
        const childWeight1 = this.get(block, 'childWeight1');
        const childWeights2 = this.get(block, 'childWeights2');
        if (childWeight1 !== (childWeights2[0] ?? 0n)) {
          console.warn(
            `Inconsistent child weights for block ${block.sillyName}! ${childWeight1} !== ${
              JSON.stringify(childWeights2.map(Number))
            }[0]`,
          );
        }
        return childWeight1;
      },

      childWeight1: (block: MeteredBlock) => {
        let weight = 0n;
        for (const child of block.children) {
          if (this.get(child, 'isConflictWinner')) {
            weight += this.get(child, 'conservativeSelfWork');
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

      childWeights2: (block: MeteredBlock) => {
        const weights: bigint[] = [];
        const addWeight = (inc: bigint, idx: number) => {
          while (weights.length <= idx) {
            weights.push(0n);
          }
          weights[idx] += inc;
        };

        const winningChildren = block.children.filter((x) => this.get(x, 'isConflictWinner'));
        for (const child of winningChildren) {
          const squashers = this.ctx.get(BlockService).getRecursiveSquashers(child);
          if (!winningChildren.some((x) => squashers.has(x))) {
            addWeight(this.get(child, 'conservativeSelfWork'), 0);

            const childWeights = this.get(child, 'childWeights2');
            for (let i = 0; i < childWeights.length; i++) {
              addWeight(childWeights[i], i > 0 ? i - 1 : 0);
            }

            for (let i = 0; i < child.treeWeights.length; i++) {
              addWeight(child.treeWeights[i], i);
            }
          }
        }

        // weights[0] is the work attributable to block
        // weights[1] is the work attributable to block.parent, but not block
        // ...
        return weights;
      },

      // TODO: Cache this on the block, should be easy cuz it never changes.
      ancestorWeight: (block: MeteredBlock) => {
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

      descendantWeight: (block: MeteredBlock) => {
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
          sum += this.get(bestSquasher, 'conservativeSelfWork');
          sum += this.get(bestSquasher, 'descendantWeight');
        }

        return sum;
      },

      conflictScore: (block: MeteredBlock) => {
        let sum = 0n;
        sum += this.get(block, 'conservativeSelfWork');
        sum += this.get(block, 'freeMarketOutput');
        sum += this.get(block, 'ancestorWeight');
        sum += this.get(block, 'descendantWeight');
        return sum;
      },

      isConflictWinner: (block: MeteredBlock) => {
        // if (block.squashers.length) {
        //   return false;
        // }

        // This is super-linear recursion but we'll refactor it into just updating the squasher
        for (const squash of block.squashes) {
          const squashBlock = this.ctx.get(BlockService).get(squash.blockHash, false);
          if (squashBlock !== undefined && !this.get(squashBlock, 'isConflictWinner')) {
            return false;
          }
        }

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

      isCanonical: (block: MeteredBlock) => {
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
