import { Context } from './Context.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { bitScatter, popcount } from './util/bitwise.ts';
import { todo } from './util/functional.ts';
import { FrontierTreeDetail } from './messages.ts';
import { assert } from '@std/assert';
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
}
