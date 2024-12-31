import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { FrontierChainService } from './FrontierChainService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { assert } from './util/functional.ts';
import { Hash } from './util/Hash.ts';

export interface MockBlock {
  frontierVoteBlock?: BlockFact | typeof ZERO_BLOCK;
  inputs: ({ blockHash: Hash; outputIdx: number; groupIdx: number } | {
    block: BlockFact;
    outputIdx: number;
    groupIdx: number;
  })[];
}

export class WalkerService {
  constructor(private ctx: Context) {}

  // Returns the path from descendant (inclusive) to ancestor (inclusive)
  public getPath<DescType extends MockBlock>(
    ancestor: BlockFact | typeof ZERO_BLOCK,
    descendant: DescType | typeof ZERO_BLOCK,
  ): (DescType | BlockFact | typeof ZERO_BLOCK)[] | undefined {
    const chain: (DescType | BlockFact | typeof ZERO_BLOCK)[] = [descendant];
    if (ancestor === descendant) {
      return chain;
    }

    const ancestorParents: Set<unknown> = this.ctx.get(FrontierChainService)
      .getAllParents(ancestor);
    let it: DescType | BlockFact | typeof ZERO_BLOCK = descendant;
    while (!ancestorParents.has(it)) {
      if (it === ZERO_BLOCK || it.frontierVoteBlock === undefined) {
        return undefined;
      }
      it = it.frontierVoteBlock;
      chain.push(it);
    }

    outerLoop: while (it !== ancestor) {
      assert(it !== ZERO_BLOCK);
      for (const input of it.inputs) {
        const child = 'block' in input
          ? input.block
          : this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          child !== undefined && input.outputIdx === child.frontierOutputIdx &&
          ancestorParents.has(child)
        ) {
          it = child;
          chain.push(it);
          continue outerLoop;
        }
      }

      throw new Error(`No tree child found in the ancestor parents set`);
    }

    return chain;
  }
}
