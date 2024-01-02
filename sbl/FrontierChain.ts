import Context from '~/sbl/Context.ts';
import Hash from '~/sbl/util/Hash.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import BlockService from '~/sbl/BlockService.ts';
import WeightService from '~/sbl/WeightService.ts';

export default class FrontierChain {
  private chain: Hash[] = [];

  constructor(private ctx: Context, hash: Hash) {
    while (true) {
      this.chain.push(hash);
      const fact = ctx.get(BlockService).get(hash);
      if (fact === undefined) {
        break;
      }
      hash = fact.frontier_vote;
    }
  }

  public static intersect(chains: FrontierChain[]) {
    this.sortAndVerifyMergeable(chains);
    return chains[0];
  }

  public static union(chains: FrontierChain[]) {
    this.sortAndVerifyMergeable(chains);
    return chains[chains.length - 1];
  }

  public find(block: BlockFact) {
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

  private static sortAndVerifyMergeable(chains: FrontierChain[]) {
    chains.sort((a, b) => a.chain.length - b.chain.length);
    for (let i = 1; i < chains.length; i++) {
      const shorter = chains[i - 1].chain;
      const longer = chains[i].chain;
      if (!Hash.equals(shorter[0], longer[longer.length - shorter.length])) {
        throw new Error(
          `Unable to compute the intersection of frontier chains!`,
        );
      }
    }
  }
}
