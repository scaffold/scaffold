import { Context } from './Context.ts';
import { BlockFact } from './FactMeta.ts';
import { BlockService } from './BlockService.ts';
import { FrontierChainService } from './FrontierChainService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';

export class WalkerService {
  constructor(private ctx: Context) {}

  // Returns the path from descendant (inclusive) to ancestor (inclusive)
  public getPath(
    ancestor: BlockFact | typeof ZERO_BLOCK,
    descendant: BlockFact,
  ): BlockFact[] | undefined {
    const chain: BlockFact[] = [descendant];
    if (ancestor === descendant) {
      return chain;
    }

    const ancestorParents = this.ctx.get(FrontierChainService)
      .getAllParents(ancestor);
    while (!ancestorParents.has(descendant)) {
      if (
        descendant.frontierVoteBlock === undefined ||
        descendant.frontierVoteBlock === ZERO_BLOCK
      ) {
        return undefined;
      }
      descendant = descendant.frontierVoteBlock;
      chain.push(descendant);
    }

    while (descendant !== ancestor) {
      for (const input of descendant.inputs) {
        const child = this.ctx.get(BlockService).get(input.blockHash, false);
        if (
          child !== undefined && input.outputIdx === child.frontierOutputIdx &&
          ancestorParents.has(child)
        ) {
          descendant = child;
          chain.push(descendant);
          break;
        }
      }
    }

    return chain;
  }
}
