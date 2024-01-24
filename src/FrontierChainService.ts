import Hash, { ZERO_HASH } from './util/Hash.ts';
import { BlockFact } from './FactMeta.ts';
import WeightService from './WeightService.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import Context from './Context.ts';
import { frontierHash } from './constants.ts';
import { todo } from './util/functional.ts';
import BlockService from './BlockService.ts';
import FrontierService2 from './FrontierService2.ts';

// The frontier can always be extended or swapped to its parent

// TODO: Move to set util
const doesIntersect = <T>(a: Set<T>, b: Set<T>) => {
  if (a.size > b.size) {
    const t = a;
    a = b;
    b = t;
  }
  for (const x of a) {
    if (b.has(x)) {
      return true;
    }
  }
  return false;
};

export default class FrontierChainService {
  constructor(private ctx: Context) {}

  public getVote(
    inputs: { block: BlockFact; outputIdx?: number }[],
  ): BlockFact | typeof ZERO_BLOCK {
    try {
      const hash = this.ctx.get(FrontierService2).getBlockVote(inputs);
      return this.ctx.get(BlockService).get(hash, false)!;
    } catch (err) {
      console.error(err);
      return ZERO_BLOCK;
    }

    // const frontierInputs = inputs.filter((input) =>
    //   input.outputIdx !== undefined &&
    //   Hash.equals(
    //     input.block.outputs[input.outputIdx].verifier.contractHash,
    //     frontierHash,
    //   )
    // );

    // todo();

    // for (let i = 1; i < frontierInputs.length; i++) {
    //   const targ = frontierInputs[i - 1];
    //   const cur = frontierInputs[i].block.frontierVoteBlock;
    // }

    // const parents = inputs.map((input) => this.getAllParents(input.block));
    // return inputs.find((input) => {
    //   const chain = this.getFrontierChain(input.block);
    //   return parents.every((p) => doesIntersect(chain, p));
    // })?.block;
  }

  // // Returns the shortest chain
  // public intersect(...chains: BlockFact[]) {
  //   this.sortAndVerifyMergeable(chains);
  //   return chains[0];
  // }

  // // Returns the longest chain
  // public union(...chains: BlockFact[]) {
  //   this.sortAndVerifyMergeable(chains);
  //   return chains[chains.length - 1];
  // }

  // private sortAndVerifyMergeable(chains: BlockFact[]) {
  //   chains.sort((a, b) => a.frontierChainDepth! - b.frontierChainDepth!);
  //   for (let i = 1; i < chains.length; i++) {
  //     if (!this.extends(chains[i - 1], chains[i])) {
  //       throw new Error(`Chains are not mergeable!`);
  //     }
  //   }
  // }

  // private extends(shorter: BlockFact, longer: BlockFact) {
  //   if (
  //     longer.frontierChainDepth === undefined ||
  //     shorter.frontierChainDepth === undefined
  //   ) {
  //     throw new Error(`Incomplete frontier chain!`);
  //   }

  //   while (longer.frontierChainDepth! > shorter.frontierChainDepth!) {
  //     const next = longer.frontierVoteBlock;
  //     if (next === undefined || next === ZERO_BLOCK) {
  //       throw new Error(`Internal error!`);
  //     }
  //     longer = next;
  //   }

  //   return longer === shorter;
  // }

  // private getBestParent(block: BlockFact) {
  //   let bestScore: bigint | undefined;
  //   let bestParent: BlockFact | undefined;
  //   for (const claim of block.outputClaims[block.frontierOutputIdx]) {
  //     const score = this.ctx.get(WeightService).getCanonicality(claim.block);
  //     if (bestParent === undefined || score > bestScore!) {
  //       bestScore = score;
  //       bestParent = claim.block;
  //     }
  //   }
  //   return bestParent;
  // }

  private getFrontierChain(block: BlockFact) {
    return this.recurse(block, (el, queue) => {
      switch (el.frontierVoteBlock) {
        case undefined:
          throw new Error(`Unconnected frontier chain!`);
        case ZERO_BLOCK:
          break;
        default:
          queue.push(el.frontierVoteBlock);
      }
    });
  }

  private getAllParents(block: BlockFact) {
    return this.recurse(block, (el, queue) => {
      for (const claim of el.outputClaims[el.frontierOutputIdx]) {
        queue.push(claim.block);
      }
    });
  }

  private recurse(
    block: BlockFact,
    pusher: (el: BlockFact, queue: BlockFact[]) => void,
  ) {
    const queue = [block];
    for (let i = 0; i < queue.length; i++) {
      pusher(queue[i], queue);
    }
    return new Set(queue);
  }
}
