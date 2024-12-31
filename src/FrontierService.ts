import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { FrontierTreeDetail } from './messages.ts';
import { assert, error, todo } from './util/functional.ts';
import { Hash } from './util/Hash.ts';
import { mapPop, mapPut } from './util/map.ts';
import { MockBlock as WalkerMockBlock, WalkerService } from './WalkerService.ts';

interface MockBlock extends WalkerMockBlock {
  frontierOutputIdx: number;
  frontierDetail: FrontierTreeDetail;
  outputs: unknown[];
}

export class FrontierService {
  constructor(private ctx: Context) {}

  create(inputs: InputSpec[], frontierVote: BlockFact | typeof ZERO_BLOCK): FrontierTreeDetail {
    const omittedOutputCount = new Map<BlockFact, number>();

    const treeChildren = inputs
      .filter((input) => input.block.frontierOutputIdx === input.outputIdx)
      .map((input) => ({
        ...input,
        rebasedSpentUtxoIdxs: this.rebase(input.block, frontierVote, omittedOutputCount),
      }));

    // TODO: Merge indices instead of sorting them
    // That should be faster since they're already sorted
    const spentUtxoIdxs = treeChildren
      .flatMap((x) => x.rebasedSpentUtxoIdxs)
      .concat(frontierVote === ZERO_BLOCK ? [] : frontierVote.inputs.map((x) => x.utxoIdx))
      .sort();

    // Assert there's no duplicates
    let prev = -1;
    for (const idx of spentUtxoIdxs) {
      assert(idx >= prev, `Subtree spent indices aren't sorted!`);
      if (idx === prev) {
        throw new Error(`Can't merge subtrees because an output is spent twice!`);
      }
      prev = idx;
    }

    const subtreeNewUtxoCount = treeChildren.map((child) => {
      const omittedSpendCount = mapPop(omittedOutputCount, child.block) ?? 0;
      const outputCount = this.getNewUtxoCount(child.block) - omittedSpendCount;
      assert(outputCount >= 0, 'outputCount < 0');
      return outputCount;
    });

    if (omittedOutputCount.size) {
      throw new Error(`Rebased through a block that isn't in our tree children!`);
    }

    return {
      treeWeights: this.ctx.get(FrontierService2).mergeTreeWeights(inputs, frontierVote),

      // frontierVoteUtxoCount: this.getTotalOutputCount(frontierVote),
      spentUtxoIdxs,
      subtreeNewUtxoCount,

      consumedInputsRoot: { branches: [] },
      producedOutputsRoot: { branches: [] },
    };
  }

  private getTotalOutputCount(block: BlockFact | typeof ZERO_BLOCK): number {
    if (block === ZERO_BLOCK) {
      return 0;
    }

    return this.getTotalOutputCount(block.frontierVoteBlock ?? error(`Unlinked`)) -
      block.frontierDetail.spentUtxoIdxs.length +
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
    omittedOutputCount: Map<BlockFact, number>,
  ): number[] {
    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Cannot rebase an orphaned block`);
    }

    let rebasedSpentUtxoIdxs = block.frontierDetail.spentUtxoIdxs;

    if (block.frontierVoteBlock === toVote) {
      return rebasedSpentUtxoIdxs;
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

          const prevCount = rebasedSpentUtxoIdxs.length;
          rebasedSpentUtxoIdxs = this.rebaseLeft(
            it.frontierDetail.spentUtxoIdxs,
            rebasedSpentUtxoIdxs,
            this.getNewUtxoCount(it),
          );

          const omittedCount = rebasedSpentUtxoIdxs.length - prevCount;
          assert(omittedCount >= 0);
          mapPut(omittedOutputCount, it, () => omittedCount, (x) => x + omittedCount);
        } else {
          // Rebase towards child
          todo(`Rebasing to a child is not implemented!`);
        }

        prev = it;
      }

      return rebasedSpentUtxoIdxs;
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

          rebasedSpentUtxoIdxs = this.rebaseRight(
            rebasedSpentUtxoIdxs,
            it.frontierDetail.spentUtxoIdxs,
            this.getNewUtxoCount(it),
          );
        } else {
          // Rebase towards parent
          todo(`Rebasing to a parent is not implemented!`);
        }

        prev = it;
      }

      return rebasedSpentUtxoIdxs;
    }

    throw Error(`Rebase failed; no path from A to B`);
  }

  private rebaseLeft(lhs: number[], rhs: number[], offset: number) {
    const result: number[] = [];
    let j = 0;
    for (const idx of rhs) {
      if (idx < offset) {
        continue;
      }

      while (j < lhs.length && lhs[j] <= idx - offset) {
        j++;
        offset--;
      }

      result.push(idx - offset);
    }
    return result;
  }

  private rebaseRight(lhs: number[], rhs: number[], offset: number) {
    const result: number[] = [];
    let j = 0;
    for (const idx of lhs) {
      while (j < rhs.length && rhs[j] < idx) {
        j++;
        offset--;
      }

      if (rhs[j] === idx) {
        throw new Error(`Can't rebase right because an output is spent twice!`);
      }

      result.push(idx + offset);
    }
    return result;
  }

  private getNewUtxoCount(block: { frontierDetail: FrontierTreeDetail; outputs: unknown[] }) {
    return block.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) +
      block.outputs.length;
  }

  public getUtxoIdx(block: BlockFact, outputIdx: number, to: MockBlock) {
    const path = this.ctx.get(WalkerService).getPath(block, to);
    if (path === undefined) {
      throw new Error('Cannot get utxo index because no path found to the block');
    }

    let prev = path.pop()!;
    assert(prev !== ZERO_BLOCK);
    path.reverse();
    // Path is from block (exclusive) to toVote (inclusive)

    for (const it of path) {
      assert(it !== ZERO_BLOCK);
      assert('hash' in prev);

      const spentIdx = this.countLt(it.frontierDetail.spentUtxoIdxs, outputIdx);
      if (it.frontierDetail.spentUtxoIdxs[spentIdx] === outputIdx) {
        throw new Error(`Can't trace output because it's already spent!`);
      }
      outputIdx -= spentIdx;

      if (it.frontierVoteBlock === prev) {
        // Frontier voter
        outputIdx += this.getNewUtxoCount(it);
      } else {
        // Parent

        // Tree children always have a group index of zero
        const treeChildren = it.inputs.filter((input) => input.groupIdx === 0);
        assert(treeChildren.length === frontierInputCount);

        const prevCpy = prev;
        const childIdx = treeChildren.findIndex((input) =>
          input.outputIdx === prevCpy.frontierOutputIdx &&
          Hash.equals('blockHash' in input ? input.blockHash : input.block.hash, prevCpy.hash)
        );
        assert(childIdx !== -1);

        outputIdx += it.frontierDetail.subtreeNewUtxoCount.slice(childIdx + 1)
          .reduce((acc, x) => acc + x, 0);
      }

      prev = it;
    }

    return outputIdx;
  }

  private countLt(arr: number[], y: number) {
    // TODO: Binary search
    const idx = arr.findIndex((x) => x >= y);
    return idx === -1 ? arr.length : idx;
  }
}
