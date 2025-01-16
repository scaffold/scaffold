import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { Hash, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { unreachable } from '@std/assert';

export interface MockBlock {
  parentBlock?: BlockFact | typeof ZERO_BLOCK;
  squashes: { blockHash: Hash }[];
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

    const squashers = new Set<DescType | BlockFact | typeof ZERO_BLOCK | undefined>(
      ancestor === ZERO_BLOCK ? [ZERO_BLOCK] : this.getSquasherChain(ancestor),
    );

    if (
      descendant !== ZERO_BLOCK &&
      !('hash' in descendant) &&
      descendant.squashes.some((squash) =>
        squashers.has(this.ctx.get(BlockService).get(squash.blockHash, false))
      )
    ) {
      // If we passed a mock descendant, it won't be linked as a parent.
      // Check here if it should be linked. If so, add it.
      squashers.add(descendant);
    }

    let it: DescType | BlockFact | typeof ZERO_BLOCK = descendant;
    while (!squashers.has(it)) {
      if (it === ZERO_BLOCK || it.parentBlock === undefined) {
        return undefined;
      }
      it = it.parentBlock;
      chain.push(it);
    }

    outerLoop: while (it !== ancestor) {
      if (it === ZERO_BLOCK) return unreachable();
      for (const squash of it.squashes) {
        const child = this.ctx.get(BlockService).get(squash.blockHash, false);
        if (child !== undefined && squashers.has(child)) {
          it = child;
          chain.push(it);
          continue outerLoop;
        }
      }

      throw new Error(`No tree child found in the ancestor parents set`);
    }

    return chain;
  }

  public getSquasherChain(block: BlockFact): BlockFact[] {
    return this.recurse(block, (el, queue) => {
      for (const squasher of el.squashers) {
        queue.push(squasher);
      }
    });
  }

  private recurse(block: BlockFact, pusher: (el: BlockFact, queue: BlockFact[]) => void) {
    const queue = [block];
    for (let i = 0; i < queue.length; i++) {
      pusher(queue[i], queue);
    }
    return queue;
  }
}
