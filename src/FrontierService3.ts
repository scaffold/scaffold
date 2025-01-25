import { assert } from '@std/assert/assert';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { error } from './util/functional.ts';
import { WalkerService } from './WalkerService.ts';
import { mapPop } from './util/map.ts';
import { mapPut } from './util/map.ts';
import { PARENT_MIN_VOLUME_RATIO } from './constants.ts';
import { BlockLinks } from './FrontierService.ts';
import { MergeabilityService } from './MergeabilityService.ts';
import { WeightService } from './WeightService.ts';
import { BlockMetrics } from './BlockMetrics.ts';

export const VOLUME_INCLUDES_SELF = false;

export class FrontierService3 {
  constructor(private ctx: Context) {}

  private score(block: BlockFact) {
    return this.ctx.get(BlockMetrics).get(block, 'conflictScore');
  }

  private findBestDescendants(
    refs: BlockFact[],
    inputs: { block: BlockFact; utxoIdxs: number[] }[],
    step: (block: BlockFact) => BlockFact[],
  ) {
    const result = [...refs];

    let options = result.flatMap((ref, idx) =>
      step(ref).map((block) => ({ idx, block, score: this.score(block) }))
    );

    while (options.length) {
      let best = options[0];
      for (const opt of options) {
        if (opt.score > best.score) {
          best = opt;
        }
      }

      const prev = result[best.idx];
      result[best.idx] = best.block;

      if (this.ctx.get(MergeabilityService).isMergeable(result, inputs)) {
        options = options.filter((x) => x.idx !== best.idx);
        for (const block of step(best.block)) {
          options.push({ idx: best.idx, block, score: this.score(block) });
        }
      } else {
        result[best.idx] = prev;
        options = options.filter((x) => x !== best);
      }
    }

    return result;
  }

  public create(refs: BlockFact[], inputs: { block: BlockFact; utxoIdxs: number[] }[]): BlockLinks {
    if (refs.length === 0) {
      return { parent: ZERO_BLOCK, squashes: [] };
    }

    if (!this.ctx.get(MergeabilityService).isMergeable(refs, inputs)) {
      throw new Error(`Unmergeable refs!`);
    }

    let roots = this.findBestDescendants(refs, inputs, (block) => block.squashers);
    roots = [...new Set(roots)];

    const heads = roots.filter((a) =>
      roots.every((b) => a === b || this.ctx.get(WalkerService).getPath(a, b) === undefined)
    );

    // Sort smallest to largest
    heads.sort((a, b) => a.volume - b.volume);

    return this.mergeSortedHeads(heads);

    // heads is really a list of sets, where each set corresponds to an input.
    // The set for input I contains a block B if B === I or B is a descendant of I, and B doesn't double-spend any other inputs

    // Move the frontier vote towards ancestors if the squashed tree size is larger than the frontier vote tree size.
    // When you move it, check if any inputs are un-included in the new frontier vote.
    // If so, you gotta add the old frontier vote as a new HEAD (if it's not an ancestor of another HEAD). By this mechanism, you can end up with N heads for N inputs.
    // Select the frontier vote that minimizes the total squashed size.
    // This will be by maximizing the ancestral weight of the frontier vote.

    // Just set frontierVote to the parent for now
  }

  // The heads array will be mutated
  private mergeSortedHeads(heads: BlockFact[]): BlockLinks {
    assert(heads.length > 0);

    // if (heads.length === 1) {
    //   return { parent: heads[0], squashes: [] };
    // }

    let parent: BlockFact | typeof ZERO_BLOCK = heads.pop()!;
    let mergedSize = heads.reduce(
      (acc, head) => acc + head.volume,
      VOLUME_INCLUDES_SELF ? 1 : heads.length,
    );

    // Squash all heads, including parents until we find a parent large enough to merge into
    while (parent !== ZERO_BLOCK && parent.volume <= mergedSize * PARENT_MIN_VOLUME_RATIO) {
      heads.push(parent);
      mergedSize += parent.volume + (VOLUME_INCLUDES_SELF ? 0 : 1);
      parent = parent.parentBlock ?? error('Unconnected chain');
    }

    return { parent, squashes: heads };
  }

  public getSizeDelta(base: BlockFact, heads: BlockFact[], getSize: (block: BlockFact) => number) {
    // If you squashed everything included in HEADS but not in BASE, what would the size be?

    assert(new Set(heads).size === heads.length);

    // Ascending order
    const state: (BlockFact | typeof ZERO_BLOCK)[] = heads.toSorted((a, b) =>
      this.ctx.get(BlockService).compareFrontierChainDepth(a, b)
    );

    let size = 0;

    while (state.length > 0) {
      const next = state.pop()!;

      if (this.ctx.get(WalkerService).getPath(next, base) !== undefined) {
        continue;
      }

      assert(next !== ZERO_BLOCK);

      size += getSize(next);

      const fv = next.parentBlock ?? error('Internal error');

      if (state.includes(fv)) {
        continue;
      }

      const idx = state.findIndex((x) =>
        this.ctx.get(BlockService).compareFrontierChainDepth(x, fv) >= 0
      );
      // -1 will be handled correctly & splice at the end of the array
      state.splice(idx, 0, fv);
    }

    return size;
  }
}
