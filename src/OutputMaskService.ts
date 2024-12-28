import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { bitScatter, popcount } from './util/bitwise.ts';
import { todo } from './util/functional.ts';
import { FrontierTreeDetail } from './messages.ts';
import { assert } from '$std/assert/assert.ts';
import { WalkerService } from './WalkerService.ts';
import { BarrierException } from './exceptions.ts';

// 0: output is unspent
// 1: output is spent

type MaskDetail = Pick<
  FrontierTreeDetail,
  'frontierVoteOutputMask' | 'frontierVoteOutputCount' | 'subtreeOutputCount'
>;

export class OutputMaskService {
  constructor(private ctx: Context) {}

  public test(block: BlockFact, outputIndex: number) {
    const byte = outputIndex >>> 3;
    return (block.frontierDetail.frontierVoteOutputMask[byte] >>>
      (outputIndex & 7)) & 1;
  }

  public mapVoteOutput(block: BlockFact, outputIndex: number) {
    const mask = block.frontierDetail.frontierVoteOutputMask;
    popcount();
    // Returns higher indices
  }

  public mapChildOutput(
    block: BlockFact,
    childIdx: number,
    outputIndex: number,
  ) {
    // Returns lower indices
  }

  private getOutputSpace(block: BlockFact) {
    const space = [];
    for (const input of block.inputs) {
      const child = this.ctx.get(BlockService).get(input.blockHash, false);
      if (child !== undefined && input.outputIdx === child.frontierOutputIdx) {
        space.push();
      }
    }
  }

  public merge(blocks: BlockFact[], vote: BlockFact): MaskDetail {
    // 1. Outputs of last child
    // 2. Outputs of first child that weren't consumed by the last child
    // 3. Outputs of the frontier vote that weren't consumed by either child

    const masks = blocks.map((x) => this.rebase(x, vote));

    const count = masks[0].frontierVoteOutputCount;
    assert(masks.every((x) => x.frontierVoteOutputCount === count));

    const len = masks[0].frontierVoteOutputMask.byteLength;
    assert(masks.every((x) => x.frontierVoteOutputMask.byteLength === len));

    const out = new Uint8Array(masks[0].frontierVoteOutputMask);
    for (let i = 1; i < len; i++) {
      const m = masks[i].frontierVoteOutputMask;
      for (let j = 0; j < len; j++) {
        if (out[j] & m[j]) {
          throw new Error(`Double spend!`);
        }
        out[j] |= m[j];
      }
    }

    for (const child of blocks) {
    }

    return {
      frontierVoteOutputMask: out,
      frontierVoteOutputCount: count,
      subtreeOutputCount: 0n,
    };
  }

  // Assumes src is the consumption mask of some block descending from it.
  // Remaps it to have the same dimensions as block.frontierDetail.frontierVoteOutputMask.
  private remap(block: BlockFact, src: Uint8Array) {
    const out = new Uint8Array(
      block.frontierDetail.frontierVoteOutputMask.byteLength,
    );
    bitScatter(
      out,
      block.frontierDetail.frontierVoteOutputMask,
      src,
      block.frontierDetail.subtreeOutputCount,
    );
    return out;
  }
  // remap(a, remap(b, c))

  // Returns a mask where each bit corresponds to a vote output.
  // A bit is set if the output is spent by (1) the block itself, or (2) the block subtree.
  private rebase(block: BlockFact, toVote: BlockFact): MaskDetail {
    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Cannot rebase an orphaned block`);
    }

    if (block.frontierVoteBlock === toVote) {
      return block.frontierDetail;
    }

    const detail = { ...block.frontierDetail };

    let path = this.ctx.get(WalkerService).getPath(
      toVote,
      block.frontierVoteBlock,
    );
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
