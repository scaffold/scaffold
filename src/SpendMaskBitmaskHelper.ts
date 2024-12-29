import { bitScatter } from './util/bitwise.ts';
import { range } from './util/functional.ts';
import { assert } from '@std/assert';

// 0: output is unspent
// 1: output is spent

interface MaskDetail {
  frontierVoteOutputCount: number;
  subtreeSpentMask: Uint8Array;
  subtreeOutputCount: number;
}

export class SpendMaskBitmaskHelper {
  public static test(mask: MaskDetail, idx: number) {
    assert(idx < mask.frontierVoteOutputCount);
    const byte = idx >>> 3;
    return (mask.subtreeSpentMask[byte] >>> (idx & 7)) & 1;
  }

  public static assertDisjoint(a: MaskDetail, b: MaskDetail) {
    assert(a.frontierVoteOutputCount === b.frontierVoteOutputCount);
    assert(
      a.subtreeSpentMask.byteLength ===
        b.subtreeSpentMask.byteLength,
    );

    for (let i = 0; i < a.subtreeSpentMask.byteLength; i++) {
      const c = a.subtreeSpentMask[i] & b.subtreeSpentMask[i];
      if (c !== 0) {
        const j = range(8).findIndex((j) => (c >>> j) & 1);
        throw new Error(`Masks intersect at index ${i * 8 + j}!`);
      }
    }
  }

  public static merge(masks: MaskDetail[]): MaskDetail {
    // 1. Outputs of last child
    // 2. Outputs of first child that weren't consumed by the last child
    // 3. Outputs of the frontier vote that weren't consumed by either child

    const count = masks[0].frontierVoteOutputCount;
    assert(masks.every((x) => x.frontierVoteOutputCount === count));

    const len = masks[0].subtreeSpentMask.byteLength;
    assert(masks.every((x) => x.subtreeSpentMask.byteLength === len));

    const out = new Uint8Array(masks[0].subtreeSpentMask);
    for (let i = 1; i < len; i++) {
      const m = masks[i].subtreeSpentMask;
      for (let j = 0; j < len; j++) {
        if (out[j] & m[j]) {
          throw new Error(`Double spend!`);
        }
        out[j] |= m[j];
      }
    }

    return {
      subtreeSpentMask: out,
      frontierVoteOutputCount: count,
      subtreeOutputCount: 0,
    };
  }

  // Assumes src is the consumption mask of some block descending from it.
  // Remaps it to have the same dimensions as block.frontierDetail.subtreeSpentMask.
  public static remap(onto: MaskDetail, src: Uint8Array) {
    const out = new Uint8Array(onto.subtreeSpentMask.byteLength);
    bitScatter(out, onto.subtreeSpentMask, src, onto.subtreeOutputCount);
    return out;
  }
  // remap(a, remap(b, c))
}
