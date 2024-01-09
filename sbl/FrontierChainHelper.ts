import Context from '~/sbl/Context.ts';
import Hash, { ZERO_HASH } from '~/sbl/util/Hash.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import BlockService from '~/sbl/BlockService.ts';
import WeightService from '~/sbl/WeightService.ts';
import { ZERO_BLOCK } from '~/sbl/BlockMeta.ts';

export default class FrontierChainHelper {
  public static intersect(...chains: BlockFact[]) {
    this.sortAndVerifyMergeable(chains);
    return chains[0];
  }

  public static union(...chains: BlockFact[]) {
    this.sortAndVerifyMergeable(chains);
    return chains[chains.length - 1];
  }

  public findParent(block: BlockFact) {
    while (true) {
      if (this.chain.some((hash) => Hash.equals(hash, block.hash))) {
        return block;
      }

      let bestScore: bigint | undefined;
      let bestDescendant: BlockFact | undefined;
      for (const claim of block.outputClaims[block.frontierOutputIdx]) {
        const score = this.ctx.get(WeightService).getCanonicality(claim.block);
        if (bestDescendant === undefined || score > bestScore!) {
          bestScore = score;
          bestDescendant = claim.block;
        }
      }

      if (bestDescendant !== undefined) {
        block = bestDescendant;
      } else {
        return;
      }
    }
  }

  private static sortAndVerifyMergeable(chains: BlockFact[]) {
    for (const chain of chains) {
      if (chain.frontierChainDepth === undefined) {
        throw new Error(`Incomplete frontier chain!`);
      }
    }
    chains.sort((a, b) => a.frontierChainDepth! - b.frontierChainDepth!);
    for (let i = 1; i < chains.length; i++) {
      const shorter = chains[i - 1];
      let ptr = chains[i];
      while (ptr.frontierChainDepth! > shorter.frontierChainDepth!) {
        const next = ptr.frontierVoteBlock;
        if (next === undefined || next === ZERO_BLOCK) {
          throw new Error(`Internal error!`);
        }
        ptr = next;
      }
      if (ptr !== shorter) {
        throw new Error(`Chains are not mergeable!`);
      }
    }
  }
}
