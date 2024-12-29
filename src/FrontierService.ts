import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { FrontierTreeDetail } from './messages.ts';
import { assert, todo } from './util/functional.ts';
import { WalkerService } from './WalkerService.ts';

interface RebasedBlock {
  frontierVoteOutputCount: number;
  subtreeSpentIdxs: number[];
  subtreeOutputCount: number;
  omittedSpendCount: number;
}

export class FrontierService {
  constructor(private ctx: Context) {}

  create(
    inputs: InputSpec[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ): FrontierTreeDetail {
    const treeChildren = inputs
      .filter((input) => input.block.frontierOutputIdx === input.outputIdx)
      .map((input) => ({
        ...input,
        ...this.rebase(input.block, frontierVote),
      }));

    let subtreeOutputCount = 0;
    for (const child of treeChildren) {
      subtreeOutputCount += child.subtreeOutputCount -
        child.block.inputs.length +
        child.block.outputs.length -
        child.omittedSpendCount;

      // TODO: Remove this once we've verified it works correctly
      if (treeChildren.some((x) => x.block === child.block.frontierVoteBlock)) {
        // We have to subtract any outputs we consume from another tree child
        // This only really works for two tree children
        const vote = child.block.frontierVoteBlock;
        assert(vote !== undefined && vote !== ZERO_BLOCK);

        const threshold = vote.outputs.length +
          vote.frontierDetail.subtreeOutputCount;
        const count = child.subtreeSpentIdxs.findIndex((x) => x >= threshold);
        const omitCount = count === -1 ? child.subtreeSpentIdxs.length : count;
        assert(child.omittedSpendCount === omitCount);
      } else {
        assert(child.omittedSpendCount === 0);
      }
    }
    assert(subtreeOutputCount >= 0, 'subtreeOutputCount < 0');

    // TODO: Merge indices instead of sorting them
    // That should be faster since they're already sorted
    const subtreeSpentIdxs = treeChildren.flatMap((x) => x.subtreeSpentIdxs)
      .sort();

    // Assert there's no duplicates
    let prev = -1;
    for (const idx of subtreeSpentIdxs) {
      assert(idx >= prev, `Subtree spent indices aren't sorted!`);
      if (idx === prev) {
        throw new Error(
          `Can't merge subtrees because an output is spent twice!`,
        );
      }
      prev = idx;
    }

    return {
      treeWeights: this.ctx.get(FrontierService2).mergeTreeWeights(
        inputs,
        frontierVote,
      ),

      frontierVoteOutputCount: this.getTotalOutputCount(frontierVote),
      subtreeSpentIdxs,
      subtreeOutputCount,

      consumedInputsRoot: { branches: [] },
      producedOutputsRoot: { branches: [] },
    };
  }

  private getTotalOutputCount(block: BlockFact | typeof ZERO_BLOCK) {
    if (block === ZERO_BLOCK) {
      return 0;
    }

    return block.frontierDetail.frontierVoteOutputCount -
      block.frontierDetail.subtreeSpentIdxs.length +
      block.frontierDetail.subtreeOutputCount -
      block.inputs.length +
      block.outputs.length;
  }

  // Returns the frontier detail that would have been created if the block had a different frontier vote
  // Spent indices will be remapped to the output space of the new vote
  // Spent indices of outputs not present on the new vote will be omitted
  public rebase(
    block: BlockFact,
    toVote: BlockFact | typeof ZERO_BLOCK,
  ): RebasedBlock {
    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Cannot rebase an orphaned block`);
    }

    const rebase: RebasedBlock = {
      ...block.frontierDetail,
      omittedSpendCount: 0,
    };

    if (block.frontierVoteBlock === toVote) {
      return rebase;
    }

    // Try rebasing by moving the vote backwards (towards ancestors)
    let path = this.ctx.get(WalkerService).getPath(
      toVote,
      block.frontierVoteBlock,
    );
    if (path !== undefined) {
      path.pop();
      // Path is from block.frontierVoteBlock (inclusive) to toVote (exclusive)

      let prev = block;
      for (const it of path) {
        assert(it !== ZERO_BLOCK);
        if (it === prev.frontierVoteBlock) {
          let offset = it.frontierDetail.subtreeOutputCount + it.outputs.length;
          let j = 0;
          const newIdxs: number[] = [];
          for (const idx of rebase.subtreeSpentIdxs) {
            if (idx < offset) {
              rebase.omittedSpendCount++;
              continue;
            }

            while (
              j < it.frontierDetail.subtreeSpentIdxs.length &&
              it.frontierDetail.subtreeSpentIdxs[j] <= idx - offset
            ) {
              j++;
              offset--;
            }

            newIdxs.push(idx - offset);
          }

          rebase.frontierVoteOutputCount = it.frontierDetail.frontierVoteOutputCount;
          rebase.subtreeSpentIdxs = newIdxs;
        } else {
          todo(`Rebasing to a child is not implemented!`);
        }

        prev = it;
      }

      return rebase;
    }

    /*
    block = X
    toVote = C

    A <- B <- C <- D
         B <- X

    path = getPath()
    path = [C, B]

    prev = path.pop()
    prev = B

    path.reverse()
    path = [C]

    it = C
    */

    // Try rebasing by moving the vote forwards (towards descendants)
    path = this.ctx.get(WalkerService).getPath(block.frontierVoteBlock, toVote);
    if (path !== undefined) {
      let prev = path.pop()!;
      path.reverse();
      // Path is from block.frontierVoteBlock (inclusive) to toVote (exclusive)

      for (const it of path) {
        assert(it !== ZERO_BLOCK);
        assert(it !== block);

        if (it.frontierVoteBlock === prev) {
          let offset = it.frontierDetail.subtreeOutputCount + it.outputs.length;
          let j = 0;
          const newIdxs: number[] = [];
          for (const idx of rebase.subtreeSpentIdxs) {
            while (
              j < it.frontierDetail.subtreeSpentIdxs.length &&
              it.frontierDetail.subtreeSpentIdxs[j] < idx
            ) {
              j++;
              offset--;
            }

            if (it.frontierDetail.subtreeSpentIdxs[j] === idx) {
              throw new Error(
                `Can't rebase through block because an output is spent twice!`,
              );
            }

            newIdxs.push(idx + offset);
          }

          rebase.frontierVoteOutputCount = it.frontierDetail.frontierVoteOutputCount;
          rebase.subtreeSpentIdxs = newIdxs;
        } else {
          todo(`Rebasing to a parent is not implemented!`);
        }

        prev = it;
      }

      return rebase;
    }

    throw Error(`Rebase failed; no path from A to B`);
  }
}
