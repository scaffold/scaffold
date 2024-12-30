import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { FrontierTreeDetail } from './messages.ts';
import { assert, todo } from './util/functional.ts';
import { Hash } from './util/Hash.ts';
import { MockBlock, WalkerService } from './WalkerService.ts';

interface RebasedBlock {
  // frontierVoteUtxoCount: number;
  subtreeSpentUtxoIdxs: number[];
  subtreeNewUtxoCount: number[];
  omittedSpendCount: number;
}

const enum OutputSource {
  FrontierVote,
  Subtree,
  Self,
}

export class FrontierService {
  constructor(private ctx: Context) {}

  create(inputs: InputSpec[], frontierVote: BlockFact | typeof ZERO_BLOCK): FrontierTreeDetail {
    const treeChildren = inputs
      .filter((input) => input.block.frontierOutputIdx === input.outputIdx)
      .map((input) => ({ ...input, ...this.rebase(input.block, frontierVote) }));

    let offset = 0;
    for (const child of treeChildren) {
      offset += child.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) +
        child.block.outputs.length;
    }

    // child2.outputs.length, child2.subtreeNewUtxoCount, child1.outputs.length, child1.subtreeNewUtxoCount

    const subtreeNewUtxoCount: number[] = [];
    for (const child of treeChildren) {
      const inputIdxs: number[] = [];
      for (const input of child.block.inputs) {
        // TODO: Request from network
        const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
        if (inputBlock === undefined) {
          return undefined;
        }
      }

      // block.frontierDetail.frontierVoteUtxoCount -
      //   block.frontierDetail.subtreeSpentUtxoIdxs.length +
      //   block.frontierDetail.subtreeNewUtxoCount -
      //   block.inputs.length +
      //   block.outputs.length;

      const newSpentIdxs: number[] = [];
      for (const idx of child.subtreeSpentUtxoIdxs) {
        newSpentIdxs.push(offset + idx);
      }
      child.subtreeSpentUtxoIdxs = newSpentIdxs;

      const outputCount = child.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) -
        child.block.inputs.length +
        child.block.outputs.length -
        child.omittedSpendCount;
      assert(outputCount >= 0, 'outputCount < 0');
      subtreeNewUtxoCount.push(outputCount);

      // TODO: Remove this once we've verified it works correctly
      if (treeChildren.some((x) => x.block === child.block.frontierVoteBlock)) {
        // We have to subtract any outputs we consume from another tree child
        // This only really works for two tree children
        const vote = child.block.frontierVoteBlock;
        assert(vote !== undefined && vote !== ZERO_BLOCK);

        const threshold = vote.outputs.length +
          vote.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0);
        assert(child.omittedSpendCount === this.countLt(child.subtreeSpentUtxoIdxs, threshold));
      } else {
        assert(child.omittedSpendCount === 0);
      }
    }

    // TODO: Merge indices instead of sorting them
    // That should be faster since they're already sorted
    const subtreeSpentUtxoIdxs = treeChildren.flatMap((x) => x.subtreeSpentUtxoIdxs).sort();

    // Assert there's no duplicates
    let prev = -1;
    for (const idx of subtreeSpentUtxoIdxs) {
      assert(idx >= prev, `Subtree spent indices aren't sorted!`);
      if (idx === prev) {
        throw new Error(`Can't merge subtrees because an output is spent twice!`);
      }
      prev = idx;
    }

    return {
      treeWeights: this.ctx.get(FrontierService2).mergeTreeWeights(inputs, frontierVote),

      frontierVoteUtxoCount: this.getTotalOutputCount(frontierVote),
      subtreeSpentUtxoIdxs,
      subtreeNewUtxoCount,

      consumedInputsRoot: { branches: [] },
      producedOutputsRoot: { branches: [] },
    };
  }

  private getTotalOutputCount(block: BlockFact | typeof ZERO_BLOCK) {
    if (block === ZERO_BLOCK) {
      return 0;
    }

    return block.frontierDetail.frontierVoteUtxoCount -
      block.frontierDetail.subtreeSpentUtxoIdxs.length +
      block.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) -
      block.inputs.length +
      block.outputs.length;
  }

  private getOutputCount(
    block: BlockFact | typeof ZERO_BLOCK,
    frontierVote: boolean,
    subtrees: number,
    self: boolean,
  ) {
    if (block === ZERO_BLOCK) {
      return 0;
    }

    return block.frontierDetail.frontierVoteUtxoCount -
      block.frontierDetail.subtreeSpentUtxoIdxs.length +
      block.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) -
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
    let path = this.ctx.get(WalkerService).getPath(toVote, block.frontierVoteBlock);
    if (path !== undefined) {
      path.pop();
      // Path is from block.frontierVoteBlock (inclusive) to toVote (exclusive)

      let prev = block;
      for (const it of path) {
        assert(it !== ZERO_BLOCK);
        if (it === prev.frontierVoteBlock) {
          // Rebase towards frontier vote
          let offset = it.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) +
            it.outputs.length;
          let j = 0;
          const newIdxs: number[] = [];
          for (const idx of rebase.subtreeSpentUtxoIdxs) {
            if (idx < offset) {
              rebase.omittedSpendCount++;
              continue;
            }

            while (
              j < it.frontierDetail.subtreeSpentUtxoIdxs.length &&
              it.frontierDetail.subtreeSpentUtxoIdxs[j] <= idx - offset
            ) {
              j++;
              offset--;
            }

            newIdxs.push(idx - offset);
          }

          rebase.subtreeSpentUtxoIdxs = newIdxs;
        } else {
          // Rebase towards child
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
      // Path is from block.frontierVoteBlock (exclusive) to toVote (inclusive)

      for (const it of path) {
        assert(it !== ZERO_BLOCK);
        assert(it !== block);

        if (it.frontierVoteBlock === prev) {
          // Rebase towards frontier voter
          let offset = it.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) +
            it.outputs.length;
          let j = 0;
          const newIdxs: number[] = [];
          for (const idx of rebase.subtreeSpentUtxoIdxs) {
            while (
              j < it.frontierDetail.subtreeSpentUtxoIdxs.length &&
              it.frontierDetail.subtreeSpentUtxoIdxs[j] < idx
            ) {
              j++;
              offset--;
            }

            if (it.frontierDetail.subtreeSpentUtxoIdxs[j] === idx) {
              throw new Error(`Can't rebase through block because an output is spent twice!`);
            }

            newIdxs.push(idx + offset);
          }

          rebase.subtreeSpentUtxoIdxs = newIdxs;
        } else {
          // Rebase towards parent
          todo(`Rebasing to a parent is not implemented!`);
        }

        prev = it;
      }

      return rebase;
    }

    throw Error(`Rebase failed; no path from A to B`);
  }

  public getUtxoIdx(block: BlockFact, outputIdx: number, to: MockBlock & { outputs: unknown[] }) {
    const path = this.ctx.get(WalkerService).getPath(block, to);
    if (path !== undefined) {
      let prev = path.pop()!;
      assert(prev !== ZERO_BLOCK);
      path.reverse();
      // Path is from block (exclusive) to toVote (inclusive)

      for (const it of path) {
        assert(it !== ZERO_BLOCK);
        assert('hash' in it);

        const spentIdx = this.countLt(it.frontierDetail.subtreeSpentUtxoIdxs, outputIdx);
        if (it.frontierDetail.subtreeSpentUtxoIdxs[spentIdx] === outputIdx) {
          throw new Error(`Can't trace output because it's spent twice!`);
        }

        if (it.frontierVoteBlock === prev) {
          // Frontier voter
          outputIdx = it.frontierDetail.subtreeSpentUtxoIdxs.length +
            it.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) -
            it.inputs.length +
            it.outputs.length +
            outputIdx -
            spentIdx;
        } else {
          // Parent
          outputIdx = prev.outputs.length;

          // Tree children always have a group index of zero
          const treeChildren = it.inputs.filter((input) => input.groupIdx === 0);
          assert(treeChildren.length === frontierInputCount);

          const child = prev;
          const childIdx = treeChildren.findIndex((input) =>
            input.outputIdx === child.frontierOutputIdx && Hash.equals(input.blockHash, child.hash)
          );
          assert(childIdx !== -1);

          outputIdx += it.frontierDetail.subtreeNewUtxoCount.slice(childIdx + 1)
            .reduce((acc, x) => acc + x, 0);
        }

        prev = it;
      }
    }
  }

  private countLt(arr: number[], y: number) {
    // TODO: Binary search
    const idx = arr.findIndex((x) => x >= y);
    return idx === -1 ? arr.length : idx;
  }
}
