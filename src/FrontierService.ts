import { InputSpec } from './BlockBuilder.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { FrontierService2 } from './FrontierService2.ts';
import { FrontierTreeDetail } from './messages.ts';
import { EMPTY_ARR } from './util/buffer.ts';
import { assert } from './util/functional.ts';
import { WalkerService } from './WalkerService.ts';

interface RebasedBlock {
  block: BlockFact;
  frontierVoteBlock: BlockFact;

  frontierVoteOutputCount: number;
  subtreeSpentIdxs: number[];
  subtreeOutputCount: number;
}

export class FrontierService {
  constructor(private ctx: Context) {}

  create(
    inputs: InputSpec[],
    frontierVote: BlockFact | typeof ZERO_BLOCK,
  ): FrontierTreeDetail {
    const treeChildren = inputs
      .filter((input) => input.block.frontierOutputIdx === input.outputIdx)
      .map((input) => this.rebase(input.block, frontierVote));

    let subtreeOutputCount = 0;
    for (const child of treeChildren) {
      subtreeOutputCount += child.block.outputs.length +
        child.subtreeOutputCount;

      if (treeChildren.some((x) => x.block === child.frontierVoteBlock)) {
        // We have to subtract any outputs we consume from another tree child
        // This only really works for two tree children
        const vote = child.frontierVoteBlock!;
        const spentIdxs = child.subtreeSpentIdxs;
        const threshold = vote.outputs.length +
          vote.frontierDetail.subtreeOutputCount;
        const count = spentIdxs.findIndex((x) => x >= threshold);
        subtreeOutputCount -= count === -1 ? spentIdxs.length : count;
      }
    }
    assert(subtreeOutputCount >= 0, 'subtreeOutputCount < 0');

    return {
      treeWeights: this.ctx.get(FrontierService2)
        .mergeTreeWeights(inputs, frontierVote),

      frontierVoteOutputCount: this.getTotalOutputCount(frontierVote),
      subtreeSpentIdxs: [],
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
      block.frontierDetail.subtreeOutputCount +
      block.outputs.length;
  }

  // Returns a mask where each bit corresponds to a vote output.
  // A bit is set if the output is spent by (1) the block itself, or (2) the block subtree.
  private rebase(
    block: BlockFact,
    toVote: BlockFact | typeof ZERO_BLOCK,
  ): RebasedBlock {
    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Cannot rebase an orphaned block`);
    }

    const rebase: RebasedBlock = {
      block,
      frontierVoteBlock: block.frontierVoteBlock,
      ...block.frontierDetail,
    };

    if (block.frontierVoteBlock === toVote) {
      return rebase;
    }

    let path = this.ctx.get(WalkerService)
      .getPath(toVote, block.frontierVoteBlock);
    if (path !== undefined) {
      // Path is from block.frontierVoteBlock to toVote

      let prev = block;
      for (const next of path) {
        if (next === prev.frontierVoteBlock) {
          detail.frontierVoteOutputMask = this.remap(
            next,
            detail.frontierVoteOutputMask,
          );
        } else {
          throw Error(`Rebasing to a child is not implemented!`);
        }
        prev = next;
      }

      return detail;
    }

    path = this.ctx.get(WalkerService).getPath(block.frontierVoteBlock, toVote);
    if (path !== undefined) {
      path.pop();
      path.reverse();
      // Path is from block.frontierVoteBlock to toVote

      let prev = block.frontierVoteBlock;
      for (const next of path) {
        if (next.frontierVoteBlock === prev) {
          assert(
            next.frontierDetail.frontierVoteOutputCount ===
              detail.frontierVoteOutputCount,
          );
          assert(
            next.frontierDetail.frontierVoteOutputMask.byteLength ===
              detail.frontierVoteOutputMask.byteLength,
          );

          for (
            let i = 0;
            i < next.frontierDetail.frontierVoteOutputMask.byteLength;
            i++
          ) {
            if (
              next.frontierDetail.frontierVoteOutputMask[i] &
              detail.frontierVoteOutputMask[i]
            ) {
              throw new Error(`Cannot merge masks with overlap!`);
            }
          }

          // ???
          detail.frontierVoteOutputMask = this.remap(
            detail.frontierVoteOutputMask,
            next.frontierDetail.frontierVoteOutputMask,
          );
        } else {
          throw Error(`Rebasing to a parent is not implemented!`);
        }
        prev = next;
      }

      return detail;
    }
  }
}
