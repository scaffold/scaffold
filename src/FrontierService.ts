import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { frontierInputCount } from './contracts/FrontierContract.ts';
import { NoBlockPathFound } from './exceptions.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { BlockOutput, FrontierTreeDetail } from './messages.ts';
import { assert, error, todo } from './util/functional.ts';
import { Hash } from './util/Hash.ts';
import { mapPop, mapPut } from './util/map.ts';
import { MockBlock as WalkerMockBlock, WalkerService } from './WalkerService.ts';

const enableChecks = true;

interface MockBlock extends WalkerMockBlock {
  frontierOutputIdx: number;
  frontierDetail: FrontierTreeDetail;
  outputs: unknown[];
}

export class FrontierService {
  constructor(private ctx: Context) {}

  create(inputs: InputSpec[], frontierVote: BlockFact | typeof ZERO_BLOCK): FrontierTreeDetail {
    const treeChildren = inputs.filter((input) =>
      input.block.frontierOutputIdx === input.outputIdx
    );
    assert(treeChildren.length === 0 || treeChildren.length === frontierInputCount);

    const fvLevel = frontierVote === ZERO_BLOCK ? Infinity : frontierVote.frontierParams.level;
    assert(treeChildren.every((input) => fvLevel > input.block.frontierParams.level));

    const omittedOutputCount = new Map<BlockFact, number>();
    const spentUtxoIdxs = this.mergeSortedIndices(
      ...treeChildren.map((input) => this.rebase(input.block, frontierVote, omittedOutputCount)),
    );

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

      // frontierVoteUtxoCount: this.getTotalUtxoCount(frontierVote),
      spentUtxoIdxs,
      subtreeNewUtxoCount,

      consumedInputsRoot: { branches: [] },
      producedOutputsRoot: { branches: [] },
    };
  }

  public getTotalUtxoCount(block: BlockFact | typeof ZERO_BLOCK): number | undefined {
    if (block === ZERO_BLOCK) {
      return 0;
    }

    if (block.utxoCount === undefined && block.frontierVoteBlock !== undefined) {
      const voteCount = this.getTotalUtxoCount(block.frontierVoteBlock);
      if (voteCount !== undefined) {
        block.utxoCount = voteCount - block.frontierDetail.spentUtxoIdxs.length +
          this.getNewUtxoCount(block);
      }
    }

    return block.utxoCount !== undefined ? block.utxoCount - block.inputs.length : undefined;
  }

  public getUtxoIdx(block: BlockFact, outputIdx: number, at: MockBlock) {
    const path = this.ctx.get(WalkerService).getPath(block, at);
    if (path === undefined) {
      throw new NoBlockPathFound('Cannot get utxo index because no path found to the block');
    }

    let prev = path.pop()!;
    assert(prev !== ZERO_BLOCK);
    path.reverse();
    // Path is from block (exclusive) to at (inclusive)

    let utxoIdx = outputIdx;

    for (const it of path) {
      assert(it !== ZERO_BLOCK);
      assert('hash' in prev);

      let offset = -this.countLt(prev.inputs.map((x) => x.utxoIdx), utxoIdx);

      if (it.frontierVoteBlock === prev) {
        // Frontier voter

        offset -= this.countLt(it.frontierDetail.spentUtxoIdxs, utxoIdx);
        offset += this.getNewUtxoCount(it);
      } else {
        // Parent

        // Tree children always have a group index of zero
        const treeChildren = it.inputs.filter((input) => input.groupIdx === 0);
        assert(treeChildren.length === frontierInputCount);

        const prevCpy = prev;
        const childIdx = treeChildren.findIndex((input) =>
          input.outputIdx === prevCpy.frontierOutputIdx &&
          ('block' in input ? input.block === prevCpy : Hash.equals(input.blockHash, prevCpy.hash))
        );
        assert(childIdx !== -1);

        for (const input of treeChildren) {
          const child = 'block' in input
            ? input.block
            : this.ctx.get(BlockService).get(input.blockHash, false);
          if (child === undefined) {
            throw new Error(`Missing tree child!`);
          }

          if (child.frontierVoteBlock === prev) {
            offset -= this.countLt(child.frontierDetail.spentUtxoIdxs, utxoIdx);
          }
        }

        offset += it.frontierDetail.subtreeNewUtxoCount.slice(childIdx + 1)
          .reduce((acc, x) => acc + x, it.outputs.length);
      }

      utxoIdx += offset;

      if (enableChecks) {
        const spec = this.getOutput(it, utxoIdx);
        assert(spec.block === block);
        assert(spec.outputIdx === outputIdx);
      }

      prev = it;
    }

    return utxoIdx;
  }

  public getOutput(
    block: MockBlock,
    utxoIdx: number,
    allowFrontierVote = true,
  ): { block: MockBlock; outputIdx: number } {
    if (utxoIdx < block.outputs.length) {
      return { block, outputIdx: utxoIdx };
    }
    utxoIdx -= block.outputs.length;

    const treeChildren = block.inputs.filter((input) => input.groupIdx === 0);
    assert(treeChildren.length === frontierInputCount || treeChildren.length === 0);

    const outputCounts = block.frontierDetail.subtreeNewUtxoCount;
    assert(outputCounts.length === treeChildren.length);

    for (let i = treeChildren.length; i-- > 0;) {
      if (utxoIdx < outputCounts[i]) {
        const input = treeChildren[i];
        const child = 'block' in input
          ? input.block
          : this.ctx.get(BlockService).get(input.blockHash, false);
        if (child === undefined) {
          throw new Error(`Missing tree child!`);
        }
        return this.getOutput(child, utxoIdx, false);
      }
      utxoIdx -= outputCounts[i];
    }

    if (!allowFrontierVote) {
      throw new Error(`Invalid tree!`);
    }

    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Missing frontier vote!`);
    }
    if (block.frontierVoteBlock === ZERO_BLOCK) {
      throw new Error(`Invalid utxoIdx!`);
    }

    return this.getOutput(block.frontierVoteBlock, utxoIdx, true);
  }

  // Returns the frontier detail that would have been created if the block had a different frontier vote
  // Spent indices will be remapped to the output space of the new vote
  // Spent indices of outputs not present on the new vote will be omitted and counted in the omittedOutputCount map
  // Also, add block's inputs and remove the frontier vote's inputs
  public rebase(
    block: BlockFact,
    toVote: BlockFact | typeof ZERO_BLOCK,
    omittedOutputCount: Map<BlockFact, number>,
  ): number[] {
    assert(block !== toVote);

    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Cannot rebase an orphaned block`);
    }

    let rebasedSpentUtxoIdxs = block.frontierDetail.spentUtxoIdxs;

    rebasedSpentUtxoIdxs = this.addSelfInputUtxos(rebasedSpentUtxoIdxs, block, omittedOutputCount);

    // rebasedSpentUtxoIdxs = this.removeFrontierVoteInputUtxos(
    //   rebasedSpentUtxoIdxs,
    //   block.frontierVoteBlock,
    // );

    if (block.frontierVoteBlock === toVote) {
      return rebasedSpentUtxoIdxs;
    }

    // Try rebasing by moving the vote backwards (towards ancestors)
    let path = this.ctx.get(WalkerService).getPath(toVote, block.frontierVoteBlock);
    if (path !== undefined) {
      path.pop();
      assert(path.length);
      // Path is from block.frontierVoteBlock (inclusive) to toVote (exclusive)

      let prev = block;
      for (const it of path) {
        assert(it !== ZERO_BLOCK);

        if (it === prev.frontierVoteBlock) {
          // Rebase towards frontier vote

          const prevCount = rebasedSpentUtxoIdxs.length;

          const vote = it.frontierVoteBlock ?? error(`Unconnected frontier vote!`);
          const spentUtxoIdxs = vote === ZERO_BLOCK
            ? it.frontierDetail.spentUtxoIdxs
            : this.mergeSortedIndices(
              it.frontierDetail.spentUtxoIdxs,
              vote.inputs.map((x) => x.utxoIdx),
            );

          rebasedSpentUtxoIdxs = this.rebaseLeft(
            spentUtxoIdxs,
            rebasedSpentUtxoIdxs,
            this.getNewUtxoCount(it),
          );

          const omittedCount = prevCount - rebasedSpentUtxoIdxs.length;
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
      assert(prev === block.frontierVoteBlock);

      path.reverse();
      assert(path.length);
      // Path is from block.frontierVoteBlock (exclusive) to toVote (inclusive)

      for (const it of path) {
        assert(it !== ZERO_BLOCK);
        assert(it !== block);

        if (it.frontierVoteBlock === prev) {
          // Rebase towards frontier voter

          const spentUtxoIdxs = prev === ZERO_BLOCK
            ? it.frontierDetail.spentUtxoIdxs
            : this.mergeSortedIndices(
              it.frontierDetail.spentUtxoIdxs,
              prev.inputs.map((x) => x.utxoIdx),
            );

          rebasedSpentUtxoIdxs = this.rebaseRight(
            rebasedSpentUtxoIdxs,
            spentUtxoIdxs,
            this.getNewUtxoCount(it),
          );
        } else {
          // Rebase towards parent

          assert(prev !== ZERO_BLOCK);

          // Tree children always have a group index of zero
          const treeChildren = it.inputs.filter((input) => input.groupIdx === 0);
          assert(treeChildren.length === frontierInputCount);

          const prevCpy = prev;
          const childIdx = treeChildren.findIndex((input) =>
            input.outputIdx === prevCpy.frontierOutputIdx &&
            ('block' in input
              ? input.block === prevCpy
              : Hash.equals(input.blockHash, prevCpy.hash))
          );
          assert(childIdx !== -1);

          const voterSpends: number[][] = [prev.inputs.map((x) => x.utxoIdx)];
          for (const input of treeChildren) {
            const child = this.ctx.get(BlockService).get(input.blockHash, false);
            if (child === undefined) {
              throw new Error(`Missing tree child!`);
            }

            if (child.frontierVoteBlock === prev) {
              // voterSpends.push(
              //   this.removeFrontierVoteInputUtxos(child.frontierDetail.spentUtxoIdxs, prev),
              // );
              voterSpends.push(child.frontierDetail.spentUtxoIdxs);
            }
          }

          const offset = it.frontierDetail.subtreeNewUtxoCount.slice(childIdx + 1)
            .reduce((acc, x) => acc + x, it.outputs.length);

          rebasedSpentUtxoIdxs = this.rebaseRight(
            rebasedSpentUtxoIdxs,
            this.mergeSortedIndices(...voterSpends),
            offset,
          );
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

  private removeFrontierVoteInputUtxos(
    utxoIdxs: number[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ) {
    if (frontierVote !== ZERO_BLOCK) {
      const removeIdxs = new Set(frontierVote.inputs.map((x) => x.utxoIdx));
      const prevSize = utxoIdxs.length;
      utxoIdxs = utxoIdxs.filter((x) => !removeIdxs.has(x));
      if (prevSize - utxoIdxs.length !== removeIdxs.size) {
        throw new Error(`Not exactly ${removeIdxs.size} utxo indices were removed!`);
      }
    }

    return utxoIdxs;
  }

  private addSelfInputUtxos(
    utxoIdxs: number[],
    block: BlockFact,
    omittedOutputCount: Map<BlockFact, number>,
  ) {
    const rebasedInputs = this.rebaseLeft(
      utxoIdxs,
      block.inputs.map((x) => x.utxoIdx),
      this.getNewUtxoCount(block),
    );

    const omittedCount = block.inputs.length - rebasedInputs.length;
    assert(omittedCount >= 0);
    mapPut(omittedOutputCount, block, () => omittedCount, (x) => x + omittedCount);

    return this.mergeSortedIndices(rebasedInputs, utxoIdxs);
  }

  private mergeSortedIndices(...arrs: number[][]) {
    if (arrs.length === 0) {
      return [];
    } else if (arrs.length === 1) {
      return arrs[0];
    }

    // TODO: Merge indices instead of sorting them
    // That should be faster since they're already sorted
    const result = arrs.flat().sort();

    // Assert there's no duplicates
    let prev = -1;
    for (const idx of result) {
      assert(idx >= prev, `Subtree spent indices aren't sorted!`);
      if (idx === prev) {
        throw new Error(`Can't merge subtrees because an output (${idx}) is spent twice!`);
      }
      prev = idx;
    }

    return result;
  }

  private getNewUtxoCount(block: { frontierDetail: FrontierTreeDetail; outputs: unknown[] }) {
    return block.frontierDetail.subtreeNewUtxoCount.reduce((acc, x) => acc + x, 0) +
      block.outputs.length;
  }

  private countLt(arr: number[], y: number) {
    // TODO: Binary search
    const idx = arr.findIndex((x) => x >= y);
    if (idx === -1) {
      return arr.length;
    } else {
      if (arr[idx] === y) {
        throw new Error(`Can't trace output because it's already spent!`);
      }
      return idx;
    }
  }
}
