import { bitScatter } from './util/bitwise.ts';
import { range } from './util/functional.ts';
import { assert } from '$std/assert/assert.ts';

// 0: output is unspent
// 1: output is spent

interface MaskDetail {
  frontierVoteOutputMask: Uint8Array;
  frontierVoteOutputCount: number;
  subtreeOutputCount: number;
}

export class VoteOutputBitmaskHelper {
  public static test(mask: MaskDetail, idx: number) {
    assert(idx < mask.frontierVoteOutputCount);
    const byte = idx >>> 3;
    return (mask.frontierVoteOutputMask[byte] >>> (idx & 7)) & 1;
  }

  public static assertDisjoint(a: MaskDetail, b: MaskDetail) {
    assert(a.frontierVoteOutputCount === b.frontierVoteOutputCount);
    assert(a.frontierVoteOutputMask.byteLength === b.frontierVoteOutputMask.byteLength);

    for (let i = 0; i < a.frontierVoteOutputMask.byteLength; i++) {
      const c = a.frontierVoteOutputMask[i] & b.frontierVoteOutputMask[i];
      if (c !== 0) {
        const j = range(8).findIndex(j => (c >>> j) & 1);
        throw new Error(`Masks intersect at index ${i * 8 + j}!`);
      }
    }
  }
  
  public static merge(masks: MaskDetail[]): MaskDetail {
    // 1. Outputs of last child
    // 2. Outputs of first child that weren't consumed by the last child
    // 3. Outputs of the frontier vote that weren't consumed by either child

    const count = masks[0].frontierVoteOutputCount;
    assert(masks.every(x => x.frontierVoteOutputCount === count));

    const len = masks[0].frontierVoteOutputMask.byteLength;
    assert(masks.every(x => x.frontierVoteOutputMask.byteLength === len));

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

    return {
      frontierVoteOutputMask: out,
      frontierVoteOutputCount: count,
      subtreeOutputCount: 0,
    };
  }

  // Assumes src is the consumption mask of some block descending from it.
  // Remaps it to have the same dimensions as block.frontierDetail.frontierVoteOutputMask.
  public static remap(onto: MaskDetail, src: Uint8Array) {
    const out = new Uint8Array(onto.frontierVoteOutputMask.byteLength);
    bitScatter(out, onto.frontierVoteOutputMask, src, onto.subtreeOutputCount);
    return out;
  }
  // remap(a, remap(b, c))
}