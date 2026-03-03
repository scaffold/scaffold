import { assert } from './util/functional.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { error } from './util/functional.ts';
import { WalkerService } from './WalkerService.ts';
import { mapPop, mapPut } from './util/map.ts';
import { BlockService } from './BlockService.ts';

export class MergeabilityService {
  constructor(private ctx: Context) {}

  public isMergeable(refs: BlockFact[], inputs: { block: BlockFact; utxoIdxs: number[] }[] = []) {
    return this.ctx.get(BlockService).isMergeable(refs, inputs);
  }

  // This method only propagates towards parents, so will not consider double-spends of a squashed block
  public isMergeableOld(refs: BlockFact[], inputs: { block: BlockFact; utxoIdxs: number[] }[]) {
    refs = [...new Set([...refs, ...inputs.map((x) => x.block)])];

    if (refs.length === 0) {
      return true;
    }

    const roots = new Set(refs.map((x) => x.parentChainRoot));
    if (roots.size !== 1) {
      throw new Error('Unconnected chains');
    }
    const [root] = roots;

    const paths = refs.flatMap((x) => {
      const path = this.ctx.get(WalkerService).getPath(root, x) ?? error('Internal error!');
      assert(path.pop() === root);
      return path;
    });
    paths.sort((a, b) => (b as BlockFact).parentChainDepth - (a as BlockFact).parentChainDepth);
    paths.push(root);

    const spends = new Map<BlockFact | typeof ZERO_BLOCK, number[]>(
      inputs.map((x) => [x.block, x.utxoIdxs]),
    );

    for (const entry of new Set(paths)) {
      const descSpends = mapPop(spends, entry) ?? [];
      if (entry === ZERO_BLOCK) {
        if (descSpends.length) {
          throw new Error(`Trying to spend an output of the zero block!`);
        }
        continue;
      }

      const inputSpends = entry.inputs.map((x) => x.utxoIdx);
      const mergedSpends = [...descSpends, ...inputSpends].sort();
      if (mergedSpends.some((x, i, arr) => i && arr[i - 1] === x)) {
        // Double spend
        return false;
      }

      if (entry === root) {
        continue;
      }

      let offset = entry.squashes.reduce(
        (acc, squash) => acc + squash.newUtxoCount,
        entry.outputs.length,
      );

      const result: number[] = [];
      let j = 0;
      for (const idx of mergedSpends) {
        if (idx < offset) {
          continue;
        }

        while (j < entry.squashedUtxoIdxs.length && entry.squashedUtxoIdxs[j] <= idx - offset) {
          j++;
          offset--;
        }

        result.push(idx - offset);
      }

      if (result.length === 0) {
        continue;
      }

      assert(entry.parentBlock !== undefined);

      mapPut(spends, entry.parentBlock, () => result, (x) => [...x, ...result]);
    }

    assert(spends.size === 0);

    return true;
  }
}
